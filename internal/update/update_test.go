package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		cand, cur string
		want      bool
	}{
		{"0.1.8", "0.1.7", true},
		{"0.1.7", "0.1.7", false},
		{"0.1.6", "0.1.7", false},
		{"0.2.0", "0.1.9", true},
		{"v1.0.0", "0.9.9", true},
		{"1.0.0", "1.0.0-rc1", true},
		{"1.0.0-rc1", "1.0.0", false},
		{"мусор", "0.1.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.cand, c.cur); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, ожидалось %v", c.cand, c.cur, got, c.want)
		}
	}
}

// feed поднимает фальшивый Syne Web: манифест, подписанный key, и файл установщика.
type feed struct {
	srv     *httptest.Server
	payload []byte
	version string
	badSig  bool
	corrupt bool
}

func newFeed(t *testing.T, priv ed25519.PrivateKey, version string) *feed {
	f := &feed{payload: []byte("MZ-fake-installer-" + strings.Repeat("x", 4096)), version: version}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/versions/latest", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("product") != Product {
			http.NotFound(w, r)
			return
		}
		sum := sha256.Sum256(f.payload)
		name := "Syne Desktop_" + f.version + "_x64-setup.exe"
		msg := name + "|" + f.version + "|" + hex.EncodeToString(sum[:]) + "|" + strconv.Itoa(len(f.payload))
		sig := ed25519.Sign(priv, []byte(msg))
		if f.badSig {
			sig[0] ^= 0xff
		}
		_ = json.NewEncoder(w).Encode(Release{
			Product: Product, Version: f.version, Name: name, SHA256: hex.EncodeToString(sum[:]),
			Size: int64(len(f.payload)), Signature: base64.RawURLEncoding.EncodeToString(sig),
			DownloadURL: "/api/releases/desktop/" + f.version + "/download",
		})
	})
	mux.HandleFunc("/api/releases/desktop/", func(w http.ResponseWriter, r *http.Request) {
		body := f.payload
		if f.corrupt {
			body = append([]byte(nil), body...)
			body[10] ^= 0xff
		}
		_, _ = w.Write(body)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func testManager(t *testing.T, f *feed, pub ed25519.PublicKey, current string) *Manager {
	m, err := newManager(f.srv.URL, t.TempDir(), current, pub)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCheckStagesVerifiedRelease(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := newFeed(t, priv, "0.2.0")
	m := testManager(t, f, pub, "0.1.7")
	if err := m.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	<-m.stage()
	rel := m.Snapshot().Release
	if rel == nil || !rel.Staged || rel.StagedPath == "" || rel.DownloadError != "" {
		t.Fatalf("релиз не подготовлен: %+v", rel)
	}
	if err := verifyFile(rel.StagedPath, rel); err != nil {
		t.Fatalf("файл не проходит проверку: %v", err)
	}
}

func TestCheckIgnoresSameOrOlderVersion(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := newFeed(t, priv, "0.1.7")
	m := testManager(t, f, pub, "0.1.7")
	if err := m.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if m.Snapshot().Release != nil {
		t.Fatal("равная версия не должна предлагаться")
	}
}

func TestCheckRejectsBadSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := newFeed(t, priv, "0.2.0")
	f.badSig = true
	m := testManager(t, f, pub, "0.1.7")
	if err := m.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("ожидалась ошибка подписи, получено %v", err)
	}
	if m.Snapshot().Release != nil {
		t.Fatal("релиз с плохой подписью принят")
	}
}

func TestCheckRejectsWrongKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	f := newFeed(t, priv, "0.2.0")
	m := testManager(t, f, otherPub, "0.1.7")
	if err := m.Check(context.Background()); err == nil {
		t.Fatal("релиз, подписанный чужим ключом, принят")
	}
}

func TestTamperedDownloadIsNotStaged(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := newFeed(t, priv, "0.2.0")
	f.corrupt = true
	m := testManager(t, f, pub, "0.1.7")
	_ = m.Check(context.Background())
	<-m.stage()
	rel := m.Snapshot().Release
	if rel == nil || rel.Staged || rel.StagedPath != "" || rel.DownloadError == "" {
		t.Fatalf("подменённый файл не должен считаться готовым: %+v", rel)
	}
	if err := m.Install(); err == nil {
		t.Fatal("установка без проверенного файла должна быть отвергнута")
	}
}

func TestSettingsPersist(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := newFeed(t, priv, "0.2.0")
	dir := t.TempDir()
	m, _ := newManager(f.srv.URL, dir, "0.1.7", pub)
	if got := m.Settings(); !got.Enabled || got.AutoInstall {
		t.Fatalf("по умолчанию проверка включена, автоустановка выключена: %+v", got)
	}
	if err := m.SetSettings(Settings{Enabled: true, AutoInstall: true}); err != nil {
		t.Fatal(err)
	}
	m2, _ := newManager(f.srv.URL, dir, "0.1.7", pub)
	if got := m2.Settings(); !got.AutoInstall {
		t.Fatalf("настройки не сохранились: %+v", got)
	}
}

func TestEmbeddedKeyIsValid(t *testing.T) {
	if _, err := New("https://example.com", t.TempDir(), "0.1.0"); err != nil {
		t.Fatal(err)
	}
}

func TestHTTPNotAllowedOutsideLocalhost(t *testing.T) {
	if _, err := New("http://example.com", t.TempDir(), "0.1.0"); err == nil {
		t.Fatal("HTTP вне localhost должен отвергаться")
	}
}
