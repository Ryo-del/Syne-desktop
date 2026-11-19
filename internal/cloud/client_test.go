package cloud

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func memStore(t *testing.T) {
	var mu sync.Mutex
	val := ""
	oldL, oldS := loadRefresh, saveRefresh
	loadRefresh = func() string { mu.Lock(); defer mu.Unlock(); return val }
	saveRefresh = func(v string) { mu.Lock(); val = v; mu.Unlock() }
	t.Cleanup(func() { loadRefresh, saveRefresh = oldL, oldS })
}

// fakeCloud — минимальный Syne Cloud: пароль, refresh, загрузка чанками, скачивание.
type fakeCloud struct {
	mu        sync.Mutex
	access    string
	gen       int
	data      []byte
	sha       string
	size      int64
	refreshes int
}

func (f *fakeCloud) handler() http.Handler {
	mux := http.NewServeMux()
	issue := func(w http.ResponseWriter) {
		f.gen++
		f.access = "acc" + strconv.Itoa(f.gen)
		json.NewEncoder(w).Encode(map[string]any{"access_token": f.access, "expires_in": 900, "refresh_token": "ref" + strconv.Itoa(f.gen),
			"user": map[string]any{"id": "u1", "login": "ivan", "name": "Иван", "role": "student"}})
	}
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		r.ParseForm()
		switch r.PostForm.Get("grant_type") {
		case "password":
			if r.PostForm.Get("password") != "secret123" || r.PostForm.Get("client_id") != ClientID {
				w.WriteHeader(400)
				return
			}
		case "refresh_token":
			f.refreshes++
			if r.PostForm.Get("refresh_token") != "ref"+strconv.Itoa(f.gen) {
				w.WriteHeader(400)
				return
			}
		}
		issue(w)
	})
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			ok := r.Header.Get("Authorization") == "Bearer "+f.access
			f.mu.Unlock()
			if !ok {
				w.WriteHeader(401)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/api/v1/uploads", auth(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Size   int64
			Sha256 string
		}
		json.NewDecoder(r.Body).Decode(&req)
		f.size, f.sha, f.data = req.Size, req.Sha256, nil
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"upload": map[string]any{"id": "up1", "size": req.Size, "received": 0, "chunk_size": 4}})
	}))
	mux.HandleFunc("/api/v1/uploads/up1", auth(func(w http.ResponseWriter, r *http.Request) {
		off, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
		b, _ := io.ReadAll(r.Body)
		if off != int64(len(f.data)) {
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(map[string]any{"upload": map[string]any{"received": len(f.data)}})
			return
		}
		f.data = append(f.data, b...)
		json.NewEncoder(w).Encode(map[string]any{"received": len(f.data)})
	}))
	mux.HandleFunc("/api/v1/uploads/up1/complete", auth(func(w http.ResponseWriter, r *http.Request) {
		sum := sha256.Sum256(f.data)
		if hex.EncodeToString(sum[:]) != f.sha {
			w.WriteHeader(422)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	mux.HandleFunc("/api/v1/me", auth(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) }))
	mux.HandleFunc("/api/v1/files/f1/content", auth(func(w http.ResponseWriter, r *http.Request) { w.Write(f.data) }))
	return mux
}

func wait(t *testing.T, jobs *Jobs, id string) Job {
	for i := 0; i < 200; i++ {
		for _, j := range jobs.Snapshot() {
			if j.ID == id && j.State != "running" {
				return j
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("передача не завершилась")
	return Job{}
}

func TestLoginRefreshUploadDownload(t *testing.T) {
	memStore(t)
	fc := &fakeCloud{}
	srv := httptest.NewServer(fc.handler())
	defer srv.Close()
	c := New(srv.URL, "тест")

	if err := c.Login("ivan", "wrong"); err == nil || err.(*Error).Code != "invalid_grant" {
		t.Fatalf("неверный пароль должен дать invalid_grant, получено %v", err)
	}
	if err := c.Login("ivan", "secret123"); err != nil {
		t.Fatal(err)
	}
	if c.User() == nil || c.User().Login != "ivan" || !c.HasSession() {
		t.Fatal("после входа должны быть пользователь и сохранённый токен")
	}

	// Сервер «забыл» токен доступа: клиент должен один раз обновиться и повторить запрос.
	fc.mu.Lock()
	fc.access = "other"
	fc.mu.Unlock()
	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	content := []byte("привет, облако — файл на несколько чанков")
	os.WriteFile(src, content, 0o600)

	jobs := NewJobs()
	up := c.Upload(jobs, src, "")
	if j := wait(t, jobs, up.ID); j.State != "done" {
		t.Fatalf("загрузка: %+v", j)
	}
	if string(fc.data) != string(content) {
		t.Fatal("сервер получил другое содержимое")
	}
	if fc.refreshes != 1 {
		t.Fatalf("ожидалось одно обновление токена, было %d", fc.refreshes)
	}

	dest := filepath.Join(dir, "out.txt")
	dl := c.Download(jobs, "f1", "a.txt", int64(len(content)), "", dest)
	if j := wait(t, jobs, dl.ID); j.State != "done" {
		t.Fatalf("скачивание: %+v", j)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != string(content) {
		t.Fatal("скачано другое содержимое")
	}
	if _, err := os.Stat(dest + ".part"); err == nil {
		t.Fatal("временный файл должен исчезнуть")
	}

	c.Logout()
	if c.HasSession() || c.User() != nil {
		t.Fatal("после выхода токена быть не должно")
	}
}

func TestRevokedRefreshSignsOut(t *testing.T) {
	memStore(t)
	fc := &fakeCloud{}
	srv := httptest.NewServer(fc.handler())
	defer srv.Close()
	c := New(srv.URL, "тест")
	if err := c.Login("ivan", "secret123"); err != nil {
		t.Fatal(err)
	}
	fc.mu.Lock()
	fc.gen += 5 // refresh-токен клиента теперь недействителен
	fc.access = "x"
	fc.mu.Unlock()
	if _, err := c.Do("GET", "me", "", nil, nil); err != ErrUnauthorized {
		t.Fatalf("ожидался ErrUnauthorized, получено %v", err)
	}
	if c.HasSession() {
		t.Fatal("недействительный вход должен стираться")
	}
}
