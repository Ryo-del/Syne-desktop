package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/Ryo-del/Syne-Desktop/internal/cloud"
)

// handleEvents — поток событий для интерфейса (SSE). Сервис держит WebSocket облака
// ({"type":"changes","cursor":N}) и пересылает уведомления; при обрыве переподключается.
func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	fmt.Fprint(w, ": ok\n\n")
	fl.Flush()

	ctx := r.Context()
	for ctx.Err() == nil {
		err := s.bridge(ctx, func(msg string) {
			fmt.Fprintf(w, "data: %s\n\n", strings.ReplaceAll(msg, "\n", " "))
			fl.Flush()
		})
		if errors.Is(err, cloud.ErrUnauthorized) {
			fmt.Fprint(w, "event: signed_out\ndata: {}\n\n")
			fl.Flush()
			return
		}
		fmt.Fprint(w, "event: down\ndata: {}\n\n")
		fl.Flush()
		select {
		case <-ctx.Done():
		case <-time.After(4 * time.Second):
		}
	}
}

func (s *server) bridge(ctx context.Context, emit func(string)) error {
	tok, err := s.cl.Token()
	if err != nil {
		return err
	}
	u := strings.Replace(s.cl.Server(), "http", "ws", 1) + "/api/v1/ws" // https→wss, http→ws
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok}}})
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)
	emit(`{"type":"open"}`) // после подключения интерфейс догоняет пропущенное
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		emit(string(data))
	}
}
