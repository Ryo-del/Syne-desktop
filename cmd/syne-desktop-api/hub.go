package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Ryo-del/Syne-protocol/hub"

	"github.com/Ryo-del/Syne-Desktop/internal/hubdev"
)

// hubService держит движок Key Hub пользователя и опрашивает облако.
type hubService struct {
	s *server

	mu         sync.Mutex
	engine     *hubdev.Engine
	userID     string
	gate       hubdev.Admission
	trustErr   *hubdev.TrustError
	lastErr    string
	pending    []hub.PendingRequest
	cancelLoop context.CancelFunc
	signedOut  string // причина принудительного выхода, показывается на экране входа
}

func dataDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "Syne")
}

// start поднимает движок пользователя (повторный вызов для того же пользователя ничего не делает).
func (h *hubService) start(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.userID == userID && h.engine != nil {
		return
	}
	h.stopLocked(false)
	h.userID = userID
	h.signedOut = ""
	h.gate = hubdev.Admission{Status: "checking"}
	h.engine = hubdev.New(hubdev.HTTPCloud{C: h.s.cl},
		hubdev.KeyringStore{Account: "device-" + userID},
		hubdev.FileStorage{Path: filepath.Join(dataDir(), "hub-"+userID+".json")})
	h.engine.SetCacheDir(filepath.Join(dataDir(), "cache-"+userID))
	ctx, cancel := context.WithCancel(context.Background())
	h.cancelLoop = cancel
	e := h.engine
	go h.loop(ctx, e)
}

// stop останавливает опрос; reset — ещё и стирает ключ устройства и данные.
func (h *hubService) stop(reset bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopLocked(reset)
}

func (h *hubService) stopLocked(reset bool) {
	if h.cancelLoop != nil {
		h.cancelLoop()
		h.cancelLoop = nil
	}
	if reset && h.engine != nil {
		h.engine.Reset()
	}
	h.engine, h.userID = nil, ""
	h.trustErr, h.lastErr, h.pending = nil, "", nil
	h.gate = hubdev.Admission{Status: "checking"}
}

func (h *hubService) forceSignOut(reason string) {
	h.stop(true)
	h.s.cl.Logout()
	h.mu.Lock()
	h.signedOut = reason
	h.mu.Unlock()
}

func (h *hubService) hostName() string { return h.s.cl.DeviceName }

func (h *hubService) evaluate(ctx context.Context, e *hubdev.Engine, force bool) {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	a := e.Admission(cctx, h.hostName(), force)
	if a.Status == "revoked" {
		h.forceSignOut("Это устройство отозвано. Войдите снова и подтвердите подключение на доверенном устройстве.")
		return
	}
	h.mu.Lock()
	opened := h.gate.Status != "open" && a.Status == "open"
	h.gate = a
	h.mu.Unlock()
	if opened {
		e.RefreshPeople(cctx)
	}
}

func (h *hubService) loop(ctx context.Context, e *hubdev.Engine) {
	h.evaluate(ctx, e, false)
	for ticks := 1; ; ticks++ {
		select {
		case <-ctx.Done():
			return
		case <-time.After(6 * time.Second):
		}
		h.tick(ctx, e, ticks, false)
	}
}

func (h *hubService) tick(ctx context.Context, e *hubdev.Engine, ticks int, force bool) {
	h.mu.Lock()
	open := h.gate.Status == "open"
	h.mu.Unlock()
	if !open {
		h.evaluate(ctx, e, false)
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if e.State() == hubdev.Ready {
		fresh, err := e.Poll(cctx)
		var te *hubdev.TrustError
		h.mu.Lock()
		switch {
		case errors.As(err, &te):
			h.trustErr = te
		case err == nil:
			h.lastErr = ""
		}
		h.mu.Unlock()
		known := e.Snapshot().Names
		for _, m := range fresh {
			if _, ok := known[m.From]; !ok && !m.Outgoing {
				e.RefreshPeople(cctx) // имя нового собеседника — сразу, а не через 5 минут
				break
			}
		}
		if force || ticks%2 == 0 {
			h.evaluate(ctx, e, true)
			h.mu.Lock()
			still := h.gate.Status == "open"
			h.mu.Unlock()
			if !still {
				return
			}
		}
		if ticks%50 == 1 {
			e.RefreshPeople(cctx)
		}
		if e.Snapshot().CanApprove {
			if p, err := e.Pending(cctx); err == nil {
				h.mu.Lock()
				h.pending = p
				h.mu.Unlock()
			}
		} else {
			h.mu.Lock()
			h.pending = nil
			h.mu.Unlock()
		}
		return
	}
	h.evaluate(ctx, e, false)
}

func (h *hubService) get() *hubdev.Engine {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.engine
}

// ── HTTP ──

type hubState struct {
	Gate    hubdev.Admission     `json:"gate"`
	View    *hubdev.View         `json:"view,omitempty"`
	Pending []hub.PendingRequest `json:"pending"`
	Trust   *hubdev.TrustError   `json:"trust_error,omitempty"`
	Error   string               `json:"error,omitempty"`
}

func (h *hubService) state() hubState {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := hubState{Gate: h.gate, Pending: h.pending, Trust: h.trustErr, Error: h.lastErr}
	if st.Pending == nil {
		st.Pending = []hub.PendingRequest{}
	}
	if h.engine != nil {
		v := h.engine.Snapshot()
		st.View = &v
	} else {
		st.Gate = hubdev.Admission{Status: "off"}
	}
	return st
}

func (h *hubService) register(mux *http.ServeMux) {
	mux.HandleFunc("/hub/state", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, h.state()) })
	mux.HandleFunc("/hub/recheck", h.post(func(ctx context.Context, e *hubdev.Engine, _ *http.Request) error {
		h.tick(ctx, e, 1, true)
		return nil
	}))
	mux.HandleFunc("/hub/retry", h.post(func(ctx context.Context, e *hubdev.Engine, _ *http.Request) error {
		e.Reset()
		h.mu.Lock()
		h.gate = hubdev.Admission{Status: "checking"}
		h.mu.Unlock()
		h.evaluate(ctx, e, false)
		return nil
	}))
	mux.HandleFunc("/hub/cancel", func(w http.ResponseWriter, r *http.Request) {
		if e := h.get(); e != nil {
			_ = e.CancelRequest(r.Context())
		}
		h.stop(true)
		h.s.cl.Logout()
		writeJSON(w, 200, h.s.state())
	})
	mux.HandleFunc("/hub/disconnect", func(w http.ResponseWriter, r *http.Request) {
		h.forceSignOut("Устройство отключено от аккаунта.")
		writeJSON(w, 200, h.s.state())
	})
	mux.HandleFunc("/hub/send", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct{ Peer, Text string }
		if err := readJSON(r, &in); err != nil || in.Peer == "" || in.Text == "" {
			return errBad
		}
		_, err := e.Send(ctx, in.Text, in.Peer)
		return err
	}))
	mux.HandleFunc("/hub/send-file", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct{ Peer, Path, Caption string }
		if err := readJSON(r, &in); err != nil || in.Peer == "" || in.Path == "" {
			return errBad
		}
		_, err := e.SendFile(ctx, in.Peer, in.Path, in.Caption)
		return err
	}))
	mux.HandleFunc("/hub/attachment/save", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct{ ID, Dest string }
		if err := readJSON(r, &in); err != nil || in.ID == "" || in.Dest == "" {
			return errBad
		}
		return e.SaveAttachment(ctx, in.ID, in.Dest)
	}))
	// Просмотр вложения: расшифровывается и проверяется до отдачи. Только картинки показываем как картинки.
	mux.HandleFunc("/hub/attachment", func(w http.ResponseWriter, r *http.Request) {
		e := h.get()
		if e == nil {
			writeJSON(w, 409, map[string]string{"error": "no_hub", "message": "Key Hub не запущен."})
			return
		}
		id := r.URL.Query().Get("id")
		path, err := e.Fetch(r.Context(), id)
		if err != nil {
			writeHubErr(w, err)
			return
		}
		ctype := "application/octet-stream"
		for _, m := range e.Snapshot().Messages {
			if m.ID == id && m.Att != nil && m.Att.Kind == "photo" {
				switch strings.ToLower(filepath.Ext(m.Att.Name)) {
				case ".jpg", ".jpeg":
					ctype = "image/jpeg"
				case ".png":
					ctype = "image/png"
				case ".gif":
					ctype = "image/gif"
				}
			}
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, path)
	})
	mux.HandleFunc("/hub/approve", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct {
			RequestID string `json:"request_id"`
			Trusted   bool
		}
		if err := readJSON(r, &in); err != nil {
			return errBad
		}
		p, ok := h.findPending(in.RequestID)
		if !ok {
			return hubdev.FormatError("запрос не найден или уже обработан")
		}
		if err := e.Approve(ctx, p.Req, in.Trusted); err != nil {
			return err
		}
		h.dropPending(in.RequestID)
		return nil
	}))
	mux.HandleFunc("/hub/reject", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if err := readJSON(r, &in); err != nil {
			return errBad
		}
		p, ok := h.findPending(in.RequestID)
		if !ok {
			return hubdev.FormatError("запрос не найден или уже обработан")
		}
		if err := e.Reject(ctx, p.Req); err != nil {
			return err
		}
		h.dropPending(in.RequestID)
		return nil
	}))
	mux.HandleFunc("/hub/promote", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct {
			DeviceID string `json:"device_id"`
		}
		if err := readJSON(r, &in); err != nil {
			return errBad
		}
		return e.Promote(ctx, in.DeviceID)
	}))
	mux.HandleFunc("/hub/revoke", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct {
			DeviceID string `json:"device_id"`
		}
		if err := readJSON(r, &in); err != nil {
			return errBad
		}
		return e.Revoke(ctx, in.DeviceID)
	}))
	mux.HandleFunc("/hub/accept-peer", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct{ Peer string }
		if err := readJSON(r, &in); err != nil {
			return errBad
		}
		if err := e.AcceptPeer(ctx, in.Peer); err != nil {
			return err
		}
		h.mu.Lock()
		h.trustErr = nil
		h.mu.Unlock()
		return nil
	}))
	mux.HandleFunc("/hub/roster", h.post(func(ctx context.Context, e *hubdev.Engine, r *http.Request) error {
		var in struct{ Confirm bool }
		if err := readJSON(r, &in); err != nil {
			return errBad
		}
		if in.Confirm {
			e.ConfirmRosterKey()
		} else {
			e.RejectRosterKey()
		}
		return nil
	}))
	mux.HandleFunc("/hub/safety", func(w http.ResponseWriter, r *http.Request) {
		e := h.get()
		if e == nil {
			writeJSON(w, 409, map[string]string{"error": "no_hub", "message": "Key Hub не запущен."})
			return
		}
		n, err := e.SafetyNumber(r.Context(), r.URL.Query().Get("peer"))
		if err != nil {
			writeHubErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"number": n})
	})
}

var errBad = errors.New("bad request")

func readJSON(r *http.Request, v any) error {
	if r.Method != http.MethodPost {
		return errBad
	}
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func (h *hubService) findPending(id string) (hub.PendingRequest, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.pending {
		if p.Req.RequestID == id {
			return p, true
		}
	}
	return hub.PendingRequest{}, false
}

func (h *hubService) dropPending(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.pending[:0:0]
	for _, p := range h.pending {
		if p.Req.RequestID != id {
			out = append(out, p)
		}
	}
	h.pending = out
}

// post оборачивает действие над движком: проверка, ошибки Hub в понятном виде, свежее состояние в ответе.
func (h *hubService) post(fn func(context.Context, *hubdev.Engine, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e := h.get()
		if e == nil {
			writeJSON(w, 409, map[string]string{"error": "no_hub", "message": "Key Hub не запущен."})
			return
		}
		if err := fn(r.Context(), e, r); err != nil {
			var te *hubdev.TrustError
			if errors.As(err, &te) {
				h.mu.Lock()
				h.trustErr = te
				h.mu.Unlock()
			}
			writeHubErr(w, err)
			return
		}
		writeJSON(w, 200, h.state())
	}
}

func writeHubErr(w http.ResponseWriter, err error) {
	var te *hubdev.TrustError
	var rk *hubdev.RosterKeyError
	switch {
	case errors.Is(err, errBad):
		http.Error(w, "bad request", 400)
	case errors.As(err, &te):
		writeJSON(w, 409, map[string]any{"error": "trust_changed", "message": te.Error(), "trust": te})
	case errors.As(err, &rk):
		writeJSON(w, 409, map[string]any{"error": "roster_key", "message": rk.Error(), "roster": rk})
	case errors.Is(err, hubdev.ErrNoHub):
		writeJSON(w, 404, map[string]string{"error": "no_hub", "message": "У этого человека нет Key Hub: защищённое сообщение отправить нельзя."})
	case errors.Is(err, hubdev.ErrNotReady):
		writeJSON(w, 409, map[string]string{"error": "not_ready", "message": err.Error()})
	default:
		writeJSON(w, 400, map[string]string{"error": "hub", "message": err.Error()})
	}
}
