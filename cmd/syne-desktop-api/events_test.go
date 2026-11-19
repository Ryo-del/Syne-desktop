package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Ryo-del/Syne-Desktop/internal/cloud"
)

func TestBridgeForwardsChanges(t *testing.T) {
	cloud.UseMemoryStore()
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"access_token": "tok", "expires_in": 900, "refresh_token": "r", "user": map[string]any{"id": "u"}})
	})
	mux.HandleFunc("/api/v1/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.Write(r.Context(), websocket.MessageText, []byte(`{"type":"changes","cursor":5}`))
		c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	s := &server{cl: cloud.New(srv.URL, "t")}
	if err := s.cl.Login("a", "b"); err != nil {
		t.Fatal(err)
	}
	var got []string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.bridge(ctx, func(m string) { got = append(got, m) })
	if len(got) != 2 || got[0] != `{"type":"open"}` || got[1] != `{"type":"changes","cursor":5}` {
		t.Fatalf("получено %q", got)
	}
}
