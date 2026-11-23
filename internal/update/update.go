// Package update проверяет, скачивает и ставит обновления Syne Desktop.
//
// Устройство то же, что у Syne Server (internal/update): манифест версий лежит в Syne Web
// (/api/versions/latest?product=desktop), подпись Ed25519 охватывает «имя|версия|sha256|размер», установщик
// скачивается в фоне, проверяется по размеру и SHA-256 и запускается только после проверки.
package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ReleasePublicKeyBase64 — открытый ключ подписи релизов Syne Web (тот же, что встроен в Syne Server).
const ReleasePublicKeyBase64 = "ymRnFoPzuxWK+bMQC9FbMd2qnyFts13Qiz13Y16zU1U="

// Product — имя продукта в Syne Web.
const Product = "desktop"

const (
	CheckInterval   = 6 * time.Hour
	BusyRetry       = 10 * time.Minute // автоустановка отложена, пока идут передачи файлов
	metadataTimeout = 15 * time.Second
)

// Release — выпуск, который объявляет Syne Web.
type Release struct {
	Product      string `json:"product"`
	Version      string `json:"version"`
	Name         string `json:"name"`
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
	Signature    string `json:"signature"`
	DownloadURL  string `json:"download_url"`
	ReleaseNotes string `json:"release_notes,omitempty"`
	// Поля ниже заполняет клиент. Release неизменяем: при смене состояния в snapshot кладётся копия.
	StagedPath    string `json:"-"`
	Staged        bool   `json:"staged"`
	Downloading   bool   `json:"downloading"`
	DownloadError string `json:"download_error,omitempty"`
}

// Snapshot — последнее известное состояние для интерфейса.
type Snapshot struct {
	CheckedAt time.Time `json:"checked_at,omitempty"`
	Release   *Release  `json:"release,omitempty"` // только если новее установленной
	Error     string    `json:"error,omitempty"`
}

// Settings — настройки обновлений (как «Проверять» и «Устанавливать автоматически» у Syne Server).
type Settings struct {
	Enabled     bool `json:"enabled"`      // проверять обновления
	AutoInstall bool `json:"auto_install"` // скачать, проверить и перезапустить без вопросов
}

// DefaultSettings: проверка включена, автоустановка выключена (как на сервере).
var DefaultSettings = Settings{Enabled: true}

type Manager struct {
	baseURL, dir, currentVersion string
	client                       *http.Client // загрузка установщика
	metaClient                   *http.Client // запрос версии
	key                          ed25519.PublicKey
	mu                           sync.RWMutex
	snapshot                     Snapshot
	settings                     Settings
	inflight                     chan struct{} // не nil, пока идёт загрузка
	kick                         chan struct{} // будит цикл Run после смены настроек
}

func New(baseURL, dir, currentVersion string) (*Manager, error) {
	keyBytes, err := base64.StdEncoding.DecodeString(ReleasePublicKeyBase64)
	if err != nil || len(keyBytes) != ed25519.PublicKeySize {
		return nil, errors.New("invalid embedded release verification key")
	}
	return newManager(baseURL, dir, currentVersion, ed25519.PublicKey(keyBytes))
}

func newManager(baseURL, dir, currentVersion string, key ed25519.PublicKey) (*Manager, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create update directory: %w", err)
	}
	baseURL = strings.TrimRight(baseURL, "/")
	base, _ := url.Parse(baseURL)
	if baseURL != "" && (base == nil || base.Hostname() == "" || (base.Scheme != "https" && base.Scheme != "http")) {
		return nil, errors.New("адрес Syne Web должен быть HTTP(S)")
	}
	if base != nil && base.Scheme == "http" && !isLoopback(base.Hostname()) {
		return nil, errors.New("адрес Syne Web должен быть HTTPS (HTTP — только для localhost)")
	}
	checkRedirect := func(req *http.Request, via []*http.Request) error {
		if base == nil || !strings.EqualFold(req.URL.Host, base.Host) {
			return errors.New("release redirect changed host")
		}
		if len(via) >= 5 {
			return errors.New("too many release redirects")
		}
		return nil
	}
	m := &Manager{
		baseURL: baseURL, dir: dir, currentVersion: currentVersion,
		client:     &http.Client{Timeout: 30 * time.Minute, CheckRedirect: checkRedirect},
		metaClient: &http.Client{Timeout: metadataTimeout, CheckRedirect: checkRedirect},
		key:        key,
		settings:   DefaultSettings,
		kick:       make(chan struct{}, 1),
	}
	m.loadSettings()
	return m, nil
}

func isLoopback(host string) bool {
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

func (m *Manager) CurrentVersion() string { return m.currentVersion }

func (m *Manager) Snapshot() Snapshot { m.mu.RLock(); defer m.mu.RUnlock(); return m.snapshot }

func (m *Manager) Settings() Settings { m.mu.RLock(); defer m.mu.RUnlock(); return m.settings }

func (m *Manager) settingsPath() string { return filepath.Join(m.dir, "settings.json") }

func (m *Manager) loadSettings() {
	raw, err := os.ReadFile(m.settingsPath())
	if err != nil {
		return
	}
	var s Settings
	if json.Unmarshal(raw, &s) == nil {
		m.settings = s
	}
}

// SetSettings сохраняет настройки и будит цикл проверки.
func (m *Manager) SetSettings(s Settings) error {
	raw, _ := json.Marshal(s)
	if err := os.WriteFile(m.settingsPath(), raw, 0o600); err != nil {
		return fmt.Errorf("сохранить настройки обновлений: %w", err)
	}
	m.mu.Lock()
	m.settings = s
	m.mu.Unlock()
	select {
	case m.kick <- struct{}{}:
	default:
	}
	return nil
}

// Install запускает проверенный NSIS-установщик. /P — без вопросов, /R — перезапуск приложения после установки.
// Установщик сам закрывает приложение; sidecar убивает хук installer-hooks.nsh.
func (m *Manager) Install() error {
	snap := m.Snapshot()
	if snap.Release == nil || snap.Release.StagedPath == "" {
		return errors.New("нет проверенного обновления Syne Desktop")
	}
	if runtime.GOOS != "windows" {
		return errors.New("установка обновления Syne Desktop поддерживается только в Windows")
	}
	if !strings.EqualFold(filepath.Ext(snap.Release.StagedPath), ".exe") {
		return errors.New("обновление Syne Desktop не является установщиком Windows")
	}
	// Файл мог испортиться или быть подменён после загрузки: проверяем ещё раз прямо перед запуском.
	if err := verifyFile(snap.Release.StagedPath, snap.Release); err != nil {
		return fmt.Errorf("установщик не прошёл проверку: %w", err)
	}
	cmd := exec.Command(snap.Release.StagedPath, "/P", "/R")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start installer: %w", err)
	}
	return cmd.Process.Release()
}

// Run периодически проверяет обновления; при включённой автоустановке ставит их, когда busy() == false.
// onInstall вызывается после успешного запуска установщика (процессу пора завершиться).
func (m *Manager) Run(ctx context.Context, busy func() bool, onInstall func()) {
	for {
		wait := CheckInterval
		if st := m.Settings(); st.Enabled {
			_ = m.Check(ctx) // ошибка сохраняется в Snapshot
			if st.AutoInstall && m.Snapshot().Release != nil {
				select {
				case <-m.stage():
				case <-ctx.Done():
					return
				}
				if rel := m.Snapshot().Release; rel != nil && rel.StagedPath != "" {
					if busy() {
						wait = BusyRetry
					} else if err := m.Install(); err != nil {
						m.setError(err.Error())
					} else {
						onInstall()
						return
					}
				}
			}
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-m.kick:
			t.Stop()
		case <-t.C:
		}
	}
}

func (m *Manager) setError(msg string) {
	m.mu.Lock()
	m.snapshot.Error = msg
	m.mu.Unlock()
}

// Check запрашивает только метаданные и проверяет подпись; установщик качается в фоне (stage).
func (m *Manager) Check(ctx context.Context) error {
	if m.baseURL == "" {
		err := errors.New("адрес Syne Web не задан")
		m.mu.Lock()
		m.snapshot.CheckedAt, m.snapshot.Error = time.Now().UTC(), err.Error()
		m.mu.Unlock()
		return err
	}
	rel, err := m.fetchRelease(ctx)
	if rel != nil && !Newer(rel.Version, m.currentVersion) {
		rel = nil
	}
	m.mu.Lock()
	next := Snapshot{CheckedAt: time.Now().UTC(), Release: keepState(m.snapshot.Release, rel)}
	if err != nil {
		next.Error = err.Error()
	}
	m.snapshot = next
	m.mu.Unlock()
	if next.Release != nil {
		m.stage()
	}
	return err
}

// keepState сохраняет состояние загрузки, если Syne Web вернул тот же релиз.
func keepState(old, fresh *Release) *Release {
	if old != nil && fresh != nil && old.Version == fresh.Version && strings.EqualFold(old.SHA256, fresh.SHA256) {
		return old
	}
	return fresh
}

// stage скачивает и проверяет установщик в фоне. Канал закрывается, когда загрузка завершена (успешно или нет).
func (m *Manager) stage() <-chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.inflight != nil {
		return m.inflight
	}
	done := make(chan struct{})
	if m.snapshot.Release == nil || m.snapshot.Release.StagedPath != "" {
		close(done)
		return done
	}
	next := *m.snapshot.Release
	next.Downloading, next.DownloadError = true, ""
	m.snapshot.Release = &next
	m.inflight = done

	go func(rel Release) {
		path, err := m.stagedOrDownload(&rel)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.inflight = nil
		defer close(done)
		cur := m.snapshot.Release
		if cur == nil || cur.Version != rel.Version || !strings.EqualFold(cur.SHA256, rel.SHA256) {
			return // пока качали, Syne Web выдал другой релиз
		}
		upd := *cur
		upd.Downloading = false
		if err != nil {
			upd.DownloadError = err.Error()
		} else {
			upd.StagedPath, upd.Staged = path, true
		}
		m.snapshot.Release = &upd
	}(next)
	return done
}

func (m *Manager) fetchRelease(ctx context.Context) (*Release, error) {
	endpoint := m.baseURL + "/api/versions/latest?product=" + url.QueryEscape(Product)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("create release request: %w", err)
	}
	resp, err := m.metaClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("check release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil // в Syne Web ещё нет ни одного релиза Desktop
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Syne Web returned HTTP %d", resp.StatusCode)
	}
	var rel Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}
	rel.StagedPath, rel.Staged, rel.Downloading, rel.DownloadError = "", false, false, ""
	if rel.Product == "" {
		rel.Product = Product
	}
	if rel.Product != Product || rel.Version == "" || rel.Name == "" || rel.Size <= 0 || rel.Size > 2<<30 || rel.DownloadURL == "" {
		return nil, errors.New("incomplete release metadata")
	}
	if _, err := hex.DecodeString(rel.SHA256); err != nil || len(rel.SHA256) != 64 {
		return nil, errors.New("invalid release SHA-256")
	}
	sig, err := base64.RawURLEncoding.DecodeString(rel.Signature)
	if err != nil || !ed25519.Verify(m.key, []byte(rel.Name+"|"+rel.Version+"|"+strings.ToLower(rel.SHA256)+"|"+strconv.FormatInt(rel.Size, 10)), sig) {
		return nil, errors.New("release signature verification failed")
	}
	artifactURL, err := url.Parse(rel.DownloadURL)
	if err != nil {
		return nil, fmt.Errorf("invalid release download URL: %w", err)
	}
	base, _ := url.Parse(m.baseURL)
	resolved := base.ResolveReference(artifactURL)
	if resolved.Scheme != "https" && !(base.Scheme == "http" && resolved.Scheme == "http") {
		return nil, errors.New("release download must use HTTPS")
	}
	if resolved.Hostname() != base.Hostname() {
		return nil, errors.New("release download changed host")
	}
	rel.DownloadURL = resolved.String()
	return &rel, nil
}

func (m *Manager) stagedPath(rel *Release) (string, error) {
	name := filepath.Base(rel.Name)
	if name == "." || name == string(filepath.Separator) || name == "" {
		return "", errors.New("invalid release file name")
	}
	return filepath.Join(m.dir, rel.Product+"-"+rel.Version+"-"+name), nil
}

// stagedOrDownload не качает файл повторно, если он уже лежит на диске и проходит проверку.
func (m *Manager) stagedOrDownload(rel *Release) (string, error) {
	dest, err := m.stagedPath(rel)
	if err != nil {
		return "", err
	}
	if verifyFile(dest, rel) == nil {
		return dest, nil
	}
	return m.downloadVerified(context.Background(), rel)
}

func verifyFile(path string, rel *Release) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, rel.Size+1))
	if err != nil {
		return err
	}
	if n != rel.Size || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(rel.SHA256) {
		return errors.New("staged release does not match metadata")
	}
	return nil
}

func (m *Manager) downloadVerified(ctx context.Context, rel *Release) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rel.DownloadURL, nil)
	if err != nil {
		return "", fmt.Errorf("create release download request: %w", err)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("release download returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength >= 0 && resp.ContentLength != rel.Size {
		return "", errors.New("release size does not match metadata")
	}
	tmp, err := os.CreateTemp(m.dir, ".release-*.part")
	if err != nil {
		return "", fmt.Errorf("create temporary release file: %w", err)
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, rel.Size+1))
	if err != nil {
		return "", fmt.Errorf("write release download: %w", err)
	}
	if n != rel.Size {
		return "", fmt.Errorf("release size mismatch: got %d, expected %d", n, rel.Size)
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(rel.SHA256) {
		return "", errors.New("release SHA-256 verification failed")
	}
	if err := tmp.Sync(); err != nil {
		return "", fmt.Errorf("sync release file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close release file: %w", err)
	}
	dest, err := m.stagedPath(rel)
	if err != nil {
		return "", err
	}
	_ = os.Remove(dest)
	if err := os.Rename(tmpPath, dest); err != nil {
		return "", fmt.Errorf("stage verified release: %w", err)
	}
	ok = true
	return dest, nil
}

// Newer сравнивает числовые части версий; понижение и равную версию отвергает.
func Newer(candidate, current string) bool {
	candidate = strings.TrimPrefix(strings.TrimPrefix(candidate, "v"), "V")
	current = strings.TrimPrefix(strings.TrimPrefix(current, "v"), "V")
	parse := func(v string) ([]int, string, bool) {
		parts := strings.SplitN(v, "-", 2)
		core := strings.Split(parts[0], ".")
		if len(core) < 3 || len(core) > 4 {
			return nil, "", false
		}
		values := make([]int, 4)
		for i, part := range core {
			n, err := strconv.Atoi(strings.SplitN(part, "+", 2)[0])
			if err != nil || n < 0 {
				return nil, "", false
			}
			values[i] = n
		}
		pre := ""
		if len(parts) == 2 {
			pre = parts[1]
		}
		return values, pre, true
	}
	a, ap, ok := parse(candidate)
	if !ok {
		return false
	}
	b, bp, ok := parse(current)
	if !ok {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	if ap == bp {
		return false
	}
	if ap == "" { // 1.0.0 новее 1.0.0-rc1
		return true
	}
	if bp == "" {
		return false
	}
	return ap > bp
}
