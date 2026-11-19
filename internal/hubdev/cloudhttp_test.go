package hubdev

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/Ryo-del/Syne-protocol/hub"

	"github.com/Ryo-del/Syne-Desktop/internal/cloud"
)

// Заголовки подписи и тела запросов должны совпадать с тем, что проверяет облако (hub.VerifyFetch).
func TestHTTPCloudWireFormat(t *testing.T) {
	u := newUser(t, "alice@org1")
	cert := u.log.State().ActiveDevices(time.Now())[0]
	var gotPost hub.InboxPost
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/hub/inbox/alice@org1":
			ts, _ := strconv.ParseInt(r.Header.Get("X-Hub-Ts"), 10, 64)
			sig, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-Hub-Sig"))
			a := hub.FetchAuth{DeviceID: r.Header.Get("X-Hub-Device"), TS: ts, Sig: sig}
			after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
			if err := hub.VerifyFetch(a, "alice@org1", after, cert, time.Now()); err != nil {
				w.WriteHeader(401)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"items": []hub.InboxItem{{ID: 7, From: "bob@org1", MsgID: "x"}}})
		case "/api/v1/hub/inbox":
			json.NewDecoder(r.Body).Decode(&gotPost)
		default:
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(map[string]string{"error": "not_bound", "message": "нет"})
		}
	}))
	defer srv.Close()
	h := HTTPCloud{C: cloud.New(srv.URL, "t")}
	ctx := context.Background()

	items, err := h.FetchInbox(ctx, "alice@org1", 3, u.study)
	if err != nil || len(items) != 1 || items[0].ID != 7 {
		t.Fatalf("входящие с подписью устройства: %v %v", items, err)
	}
	env, _ := hub.Seal([]byte("x"), []byte("c"), u.study, []hub.Certificate{cert})
	if err := h.PostInbox(ctx, hub.InboxPost{From: "alice@org1", To: "bob@org1", Envelope: env, MsgID: "m"}); err != nil {
		t.Fatal(err)
	}
	if gotPost.MsgID != "m" || gotPost.Envelope == nil || hub.VerifyPost(&gotPost, cert) != nil {
		t.Fatalf("тело доставки повреждено: %+v", gotPost)
	}
	if err := h.PostOp(ctx, hub.CloudOp{Login: "alice@org1", Kind: "approve"}); !isCode(err, "not_bound") {
		t.Fatalf("код ошибки облака должен сохраняться: %v", err)
	}
}
