// syne-desktop-api — локальный сервис десктопного клиента Syne.
// Интерфейс (Tauri/React) говорит только с ним: он хранит вход, обновляет токены
// и пересылает запросы в Syne Cloud. Доступ закрыт случайным токеном запуска.
package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Ryo-del/Syne-Desktop/internal/cloud"
)

type server struct {
	token string
	cl    *cloud.Client
	jobs  *cloud.Jobs
	hub   *hubService
}

func main() {
	addr := flag.String("addr", "127.0.0.1:38674", "адрес локального API")
	server_ := flag.String("server", "", "адрес Syne Cloud")
	exitOnStdin := flag.Bool("exit-on-stdin-close", false, "завершиться, когда закроется stdin")
	flag.Parse()

	host, _ := os.Hostname()
	if host == "" {
		host = "Компьютер"
	}
	s := &server{token: os.Getenv("SYNE_API_TOKEN"), cl: cloud.New(*server_, host), jobs: cloud.NewJobs()}
	s.hub = &hubService{s: s}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("/auth/state", s.handleState)
	mux.HandleFunc("/auth/login", s.handleLogin)
	mux.HandleFunc("/auth/logout", s.handleLogout)
	mux.HandleFunc("/cloud/", s.handleProxy)
	s.hub.register(mux)
	mux.HandleFunc("/events", s.handleEvents)
	mux.HandleFunc("/transfers", s.handleTransfers)
	mux.HandleFunc("/transfers/upload", s.handleUpload)
	mux.HandleFunc("/transfers/download", s.handleDownload)
	mux.HandleFunc("/transfers/cancel", s.handleCancel)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	if *exitOnStdin {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); os.Exit(0) }()
	}
	log.Printf("syne-desktop-api: %s", *addr)
	log.Fatal((&http.Server{Handler: s.guard(mux), ReadHeaderTimeout: 10 * time.Second}).Serve(ln))
}

var allowedOrigins = map[string]bool{
	"tauri://localhost": true, "http://tauri.localhost": true, "https://tauri.localhost": true,
	"http://localhost:1420": true, "http://127.0.0.1:1420": true,
}

func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			if !allowedOrigins[o] {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range, X-Syne-Token")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Content-Disposition, Accept-Ranges, ETag")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		tok := r.Header.Get("X-Syne-Token")
		if tok == "" && r.URL.Path == "/events" { // EventSource не умеет заголовки
			tok = r.URL.Query().Get("token")
		}
		if s.token != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var ce *cloud.Error
	switch {
	case errors.Is(err, cloud.ErrUnauthorized):
		writeJSON(w, 401, map[string]string{"error": "unauthorized", "message": "Войдите заново."})
	case errors.As(err, &ce):
		st := ce.Status
		if st == 0 {
			st = 502
		}
		writeJSON(w, st, map[string]string{"error": ce.Code, "message": ce.Message})
	default:
		writeJSON(w, 502, map[string]string{"error": "unavailable", "message": "Нет связи с сервером."})
	}
}

func (s *server) state() map[string]any {
	out := map[string]any{"server": s.cl.Server(), "signed_in": false}
	if s.cl.HasSession() {
		out["signed_in"] = true
		if u := s.cl.User(); u != nil {
			out["user"] = u
		}
	}
	return out
}

func (s *server) handleState(w http.ResponseWriter, r *http.Request) {
	st := s.state()
	// Пользователь известен только после обновления токена: подтягиваем при первом запросе.
	if st["signed_in"] == true && st["user"] == nil {
		if err := s.cl.Refresh(""); err != nil {
			if errors.Is(err, cloud.ErrUnauthorized) {
				writeJSON(w, 200, s.state())
				return
			}
			st["offline"] = true
			writeJSON(w, 200, st)
			return
		}
		st = s.state()
	}
	if u := s.cl.User(); st["signed_in"] == true && u != nil {
		s.hub.start(u.ID)
	}
	s.hub.mu.Lock()
	if reason := s.hub.signedOut; reason != "" && st["signed_in"] == false {
		st["reason"] = reason
	}
	s.hub.mu.Unlock()
	writeJSON(w, 200, st)
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password, Server string }
	if r.Method != http.MethodPost || json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	if in.Server != "" {
		if !strings.HasPrefix(in.Server, "https://") && !strings.HasPrefix(in.Server, "http://localhost") && !strings.HasPrefix(in.Server, "http://127.0.0.1") {
			writeJSON(w, 400, map[string]string{"error": "bad_server", "message": "Адрес сервера должен начинаться с https://"})
			return
		}
		s.cl.SetServer(in.Server)
	}
	if err := s.cl.Login(strings.TrimSpace(in.Username), in.Password); err != nil {
		writeErr(w, err)
		return
	}
	st := s.state()
	if u := s.cl.User(); u != nil {
		s.hub.start(u.ID)
	}
	writeJSON(w, 200, st)
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.hub.stop(true)
	s.cl.Logout()
	writeJSON(w, 200, s.state())
}

// handleProxy пересылает /cloud/<путь> в /api/v1/<путь> облака.
func (s *server) handleProxy(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/cloud/")
	var body io.Reader
	if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
		body = r.Body
	}
	resp, err := s.cl.Do(r.Method, path, r.URL.RawQuery, r.Header, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (s *server) handleTransfers(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		s.jobs.Clear()
	}
	writeJSON(w, 200, map[string]any{"transfers": s.jobs.Snapshot()})
}

func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Paths    []string `json:"paths"`
		ParentID string   `json:"parent_id"`
	}
	if r.Method != http.MethodPost || json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	for _, p := range in.Paths {
		s.cl.Upload(s.jobs, p, in.ParentID)
	}
	writeJSON(w, 202, map[string]any{"transfers": s.jobs.Snapshot()})
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID, Name, Version, Dest string
		Size                    int64
	}
	if r.Method != http.MethodPost || json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in) != nil || in.ID == "" || in.Dest == "" {
		http.Error(w, "bad request", 400)
		return
	}
	s.cl.Download(s.jobs, in.ID, in.Name, in.Size, in.Version, in.Dest)
	writeJSON(w, 202, map[string]any{"transfers": s.jobs.Snapshot()})
}

func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	s.jobs.Cancel(r.URL.Query().Get("id"))
	writeJSON(w, 200, map[string]any{"transfers": s.jobs.Snapshot()})
}
