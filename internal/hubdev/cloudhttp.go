package hubdev

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/Ryo-del/Syne-Desktop/internal/cloud"
	"github.com/Ryo-del/Syne-protocol/hub"
)

// HTTPCloud — Hub поверх Syne Cloud. Часть маршрутов требует токен аккаунта, часть (входящие,
// операции доверенного устройства) — только подпись ключа устройства.
type HTTPCloud struct{ C *cloud.Client }

func decodeErr(resp *http.Response) error {
	var b struct {
		Error, Message string
		Received       int64
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&b)
	msg := b.Message
	if msg == "" {
		msg = fmt.Sprintf("Ошибка сервера (%d)", resp.StatusCode)
	}
	return &CodeError{Code: b.Error, Message: msg, Status: resp.StatusCode, Received: b.Received}
}

// authed — запрос с токеном аккаунта.
func (h HTTPCloud) authed(ctx context.Context, method, path, query string, body any, out any) error {
	var rd io.Reader
	hdr := http.Header{}
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
		hdr.Set("Content-Type", "application/json")
	}
	resp, err := h.C.Do(method, path, query, hdr, rd)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return decodeErr(resp)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// signed — запрос без токена: подпись устройства в заголовках (если key != nil).
func (h HTTPCloud) signed(ctx context.Context, method, path, query string, body any, auth *hub.FetchAuth, out any) error {
	u := h.C.Server() + "/api/v1/" + path
	if query != "" {
		u += "?" + query
	}
	var rd io.Reader
	ctype := "application/json"
	switch b := body.(type) {
	case nil:
	case []byte:
		rd, ctype = bytes.NewReader(b), "application/octet-stream"
	default:
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", ctype)
	}
	if auth != nil {
		req.Header.Set("X-Hub-Device", auth.DeviceID)
		req.Header.Set("X-Hub-Ts", strconv.FormatInt(auth.TS, 10))
		req.Header.Set("X-Hub-Sig", base64.StdEncoding.EncodeToString(auth.Sig))
	}
	cl := &http.Client{Timeout: 30 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return &cloud.Error{Code: "unavailable", Message: "Нет связи с сервером."}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return decodeErr(resp)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (h HTTPCloud) Me(ctx context.Context) (string, string, error) {
	var r struct {
		Login      string `json:"login"`
		SchoolName string `json:"school_name"`
	}
	if err := h.authed(ctx, "GET", "hub/me", "", nil, &r); err != nil {
		return "", "", err
	}
	return r.Login, r.SchoolName, nil
}

func (h HTTPCloud) People(ctx context.Context) ([]Person, error) {
	var r struct{ People []Person }
	err := h.authed(ctx, "GET", "hub/people", "", nil, &r)
	return r.People, err
}

func (h HTTPCloud) Groups(ctx context.Context) (GroupsResponse, error) {
	var r struct {
		Key     string            `json:"key"`
		Rosters []hub.GroupRoster `json:"rosters"`
	}
	if err := h.authed(ctx, "GET", "hub/groups", "", nil, &r); err != nil {
		return GroupsResponse{}, err
	}
	key, _ := base64.StdEncoding.DecodeString(r.Key)
	return GroupsResponse{Key: key, Rosters: r.Rosters}, nil
}

func (h HTTPCloud) Registry(ctx context.Context, login string, after uint64) ([]hub.Entry, error) {
	var r struct{ Entries []hub.Entry }
	q := url.Values{"after": {strconv.FormatUint(after, 10)}}.Encode()
	err := h.authed(ctx, "GET", "hub/registry/"+url.PathEscape(login), q, nil, &r)
	return r.Entries, err
}

func (h HTTPCloud) RequestRegistration(ctx context.Context, req hub.CertRequest) error {
	return h.authed(ctx, "POST", "hub/requests", "", map[string]any{"req": req}, nil)
}

func (h HTTPCloud) RequestStatus(ctx context.Context, id string) (string, error) {
	var r struct{ Status string }
	err := h.authed(ctx, "GET", "hub/requests/status/"+url.PathEscape(id), "", nil, &r)
	return r.Status, err
}

func (h HTTPCloud) CancelRequest(ctx context.Context, id string) error {
	return h.authed(ctx, "POST", "hub/requests/"+url.PathEscape(id)+"/cancel", "", nil, nil)
}

func (h HTTPCloud) PendingRequests(ctx context.Context, login string, key *hub.DeviceKey) ([]hub.PendingRequest, error) {
	a := key.SignAction(hub.DomainRequestsFetch, login, 0, time.Now())
	var r struct{ Pending []hub.PendingRequest }
	err := h.signed(ctx, "GET", "hub/requests/"+url.PathEscape(login), "", nil, &a, &r)
	return r.Pending, err
}

func (h HTTPCloud) PostOp(ctx context.Context, op hub.CloudOp) error {
	return h.signed(ctx, "POST", "hub/ops", "", op, nil, nil)
}

func (h HTTPCloud) PostInbox(ctx context.Context, p hub.InboxPost) error {
	return h.signed(ctx, "POST", "hub/inbox", "", p, nil, nil)
}

func (h HTTPCloud) FetchInbox(ctx context.Context, login string, after int64, key *hub.DeviceKey) ([]hub.InboxItem, error) {
	a := key.SignFetch(login, after, time.Now())
	var r struct{ Items []hub.InboxItem }
	q := url.Values{"after": {strconv.FormatInt(after, 10)}}.Encode()
	err := h.signed(ctx, "GET", "hub/inbox/"+url.PathEscape(login), q, nil, &a, &r)
	return r.Items, err
}

// ── вложения ──

func (h HTTPCloud) Limits(ctx context.Context) (Limits, error) {
	var l Limits
	err := h.authed(ctx, "GET", "hub/limits", "", nil, &l)
	return l, err
}

func (h HTTPCloud) BlobStart(ctx context.Context, key *hub.DeviceKey, login, id string, size int64) (int64, bool, error) {
	a := key.SignBlob(hub.DomainBlobPut, login, id, size, time.Now())
	var r struct {
		Received int64 `json:"received"`
		Complete bool  `json:"complete"`
	}
	err := h.signed(ctx, "POST", "hub/blobs", "", map[string]any{"from": login, "blob": id, "size": size}, &a, &r)
	return r.Received, r.Complete, err
}

func (h HTTPCloud) BlobPut(ctx context.Context, key *hub.DeviceKey, login, id string, size, offset int64, data []byte) (int64, error) {
	a := key.SignBlob(hub.DomainBlobPut, login, id, size, time.Now())
	var r struct {
		Received int64 `json:"received"`
	}
	q := url.Values{"from": {login}, "offset": {strconv.FormatInt(offset, 10)}}.Encode()
	err := h.signed(ctx, "PUT", "hub/blobs/"+id, q, data, &a, &r)
	if ce, ok := err.(*CodeError); ok && ce.Code == "offset_mismatch" {
		return 0, &OffsetError{Received: ce.Received}
	}
	return r.Received, err
}

func (h HTTPCloud) BlobComplete(ctx context.Context, key *hub.DeviceKey, login, id string, size int64) error {
	a := key.SignBlob(hub.DomainBlobPut, login, id, size, time.Now())
	return h.signed(ctx, "POST", "hub/blobs/"+id+"/complete", url.Values{"from": {login}}.Encode(), nil, &a, nil)
}

func (h HTTPCloud) BlobGet(ctx context.Context, key *hub.DeviceKey, login, id string) (io.ReadCloser, error) {
	a := key.SignBlob(hub.DomainBlobGet, login, id, 0, time.Now())
	u := h.C.Server() + "/api/v1/hub/blobs/" + id + "?" + url.Values{"login": {login}}.Encode()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Hub-Device", a.DeviceID)
	req.Header.Set("X-Hub-Ts", strconv.FormatInt(a.TS, 10))
	req.Header.Set("X-Hub-Sig", base64.StdEncoding.EncodeToString(a.Sig))
	resp, err := (&http.Client{}).Do(req) // без общего таймаута: файл может быть большим
	if err != nil {
		return nil, &cloud.Error{Code: "unavailable", Message: "Нет связи с сервером."}
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		return nil, decodeErr(resp)
	}
	return resp.Body, nil
}
