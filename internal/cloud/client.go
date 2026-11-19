// Пакет cloud — клиент Syne Cloud для десктопа: вход логином и паролем,
// обновление токенов и проксирование запросов. Те же правила, что в iOS-клиенте.
package cloud

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	ClientID      = "syne-windows" // десктопный клиент облака (loopback-класс)
	DefaultServer = "https://cloud.syne-network.ru"
	keyService    = "syne-desktop"
	maxBody       = 64 << 20
)

var ErrUnauthorized = errors.New("unauthorized")

// User — пользователь облака (поле user в ответе /oauth/token).
type User struct {
	ID       string  `json:"id"`
	Login    string  `json:"login"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	SchoolID *string `json:"school_id"`
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	User         User   `json:"user"`
}

// Error — ошибка входа с текстом для человека.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

type Client struct {
	DeviceName string
	HTTP       *http.Client

	mu      sync.Mutex
	server  string
	access  string
	expires time.Time
	user    *User
	refresh sync.Mutex // один обновляющий запрос на всех: refresh-токен одноразовый
}

func New(server, deviceName string) *Client {
	if server == "" {
		server = DefaultServer
	}
	return &Client{
		DeviceName: deviceName,
		server:     strings.TrimRight(server, "/"),
		HTTP:       &http.Client{Timeout: 0}, // загрузки длинные; сроки задаёт вызывающий
	}
}

func (c *Client) Server() string { c.mu.Lock(); defer c.mu.Unlock(); return c.server }

func (c *Client) SetServer(s string) {
	c.mu.Lock()
	c.server = strings.TrimRight(s, "/")
	c.mu.Unlock()
}

func (c *Client) User() *User { c.mu.Lock(); defer c.mu.Unlock(); return c.user }

// HasSession — есть сохранённый refresh-токен.
func (c *Client) HasSession() bool { return loadRefresh() != "" }

// Хранилище refresh-токена: связка ключей ОС. В тестах подменяется.
var (
	loadRefresh = func() string {
		v, err := keyring.Get(keyService, "refresh_token")
		if err != nil {
			return ""
		}
		return v
	}
	saveRefresh = func(v string) {
		if v == "" {
			_ = keyring.Delete(keyService, "refresh_token")
			return
		}
		_ = keyring.Set(keyService, "refresh_token", v)
	}
)

func (c *Client) form(fields url.Values) (*http.Response, error) {
	req, _ := http.NewRequest("POST", c.Server()+"/oauth/token", strings.NewReader(fields.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	cl := *c.HTTP
	cl.Timeout = 30 * time.Second
	return cl.Do(req)
}

func (c *Client) adopt(t tokenResponse) {
	c.mu.Lock()
	c.access = t.AccessToken
	c.expires = time.Now().Add(time.Duration(t.ExpiresIn) * time.Second)
	u := t.User
	c.user = &u
	c.mu.Unlock()
	saveRefresh(t.RefreshToken)
}

// Login — вход логином и паролем (grant_type=password). Пароль нигде не хранится.
func (c *Client) Login(username, password string) error {
	resp, err := c.form(url.Values{
		"grant_type": {"password"}, "client_id": {ClientID},
		"username": {username}, "password": {password}, "device_name": {c.DeviceName},
	})
	if err != nil {
		return &Error{Code: "unavailable", Message: "Нет связи с сервером. Проверьте интернет."}
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		var t tokenResponse
		if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
			return &Error{Code: "bad_response", Message: "Не удалось разобрать ответ сервера."}
		}
		c.adopt(t)
		return nil
	case 429:
		return &Error{Status: 429, Code: "too_many_attempts", Message: "Слишком много попыток. Подождите несколько минут."}
	case 400, 401:
		return &Error{Status: resp.StatusCode, Code: "invalid_grant", Message: "Неверный логин или пароль."}
	}
	return &Error{Status: resp.StatusCode, Code: "unavailable", Message: "Не удалось войти. Попробуйте ещё раз."}
}

// Refresh обновляет токены. stale — токен, с которым пришёл неудачный запрос:
// если его уже заменили, второй раз не обновляем.
func (c *Client) Refresh(stale string) error {
	c.refresh.Lock()
	defer c.refresh.Unlock()
	c.mu.Lock()
	if stale != "" && c.access != stale && c.access != "" {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()
	rt := loadRefresh()
	if rt == "" {
		return ErrUnauthorized
	}
	resp, err := c.form(url.Values{
		"grant_type": {"refresh_token"}, "client_id": {ClientID},
		"refresh_token": {rt}, "device_name": {c.DeviceName},
	})
	if err != nil {
		return &Error{Code: "unavailable", Message: "Нет связи с сервером."}
	}
	defer resp.Body.Close()
	if resp.StatusCode == 400 || resp.StatusCode == 401 {
		c.Clear()
		return ErrUnauthorized
	}
	if resp.StatusCode != 200 {
		return &Error{Status: resp.StatusCode, Code: "unavailable", Message: "Сервер недоступен."}
	}
	var t tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
		return &Error{Code: "bad_response", Message: "Не удалось разобрать ответ сервера."}
	}
	c.adopt(t)
	return nil
}

// Clear забывает вход на этом компьютере.
func (c *Client) Clear() {
	c.mu.Lock()
	c.access, c.user = "", nil
	c.mu.Unlock()
	saveRefresh("")
}

// Logout отзывает токен на сервере и стирает его локально.
func (c *Client) Logout() {
	if rt := loadRefresh(); rt != "" {
		req, _ := http.NewRequest("POST", c.Server()+"/oauth/revoke", strings.NewReader(url.Values{"token": {rt}}.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		cl := *c.HTTP
		cl.Timeout = 10 * time.Second
		if resp, err := cl.Do(req); err == nil {
			resp.Body.Close()
		}
	}
	c.Clear()
}

func (c *Client) token() (string, error) {
	c.mu.Lock()
	tok, exp := c.access, c.expires
	c.mu.Unlock()
	if tok == "" || time.Until(exp) < 30*time.Second {
		if err := c.Refresh(tok); err != nil {
			return "", err
		}
		c.mu.Lock()
		tok = c.access
		c.mu.Unlock()
	}
	return tok, nil
}

// Do отправляет запрос в /api/v1/<path> с токеном; при 401 один раз обновляет и повторяет.
func (c *Client) Do(method, path, rawQuery string, header http.Header, body io.Reader) (*http.Response, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = io.ReadAll(io.LimitReader(body, maxBody+1)); err != nil {
			return nil, err
		}
		if len(payload) > maxBody {
			return nil, &Error{Status: 413, Code: "too_large", Message: "Слишком большой запрос."}
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		tok, err := c.token()
		if err != nil {
			return nil, err
		}
		u := c.Server() + "/api/v1/" + strings.TrimLeft(path, "/")
		if rawQuery != "" {
			u += "?" + rawQuery
		}
		var rd io.Reader
		if payload != nil {
			rd = bytes.NewReader(payload)
		}
		req, err := http.NewRequest(method, u, rd)
		if err != nil {
			return nil, err
		}
		for _, h := range []string{"Content-Type", "Range", "If-None-Match", "X-Syne-Offset", "X-Syne-Hash"} {
			if v := header.Get(h); v != "" {
				req.Header.Set(h, v)
			}
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("X-Syne-Device", c.DeviceName)
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return nil, &Error{Code: "unavailable", Message: "Нет связи с сервером. Проверьте интернет."}
		}
		if resp.StatusCode == 401 && attempt == 0 {
			resp.Body.Close()
			if err := c.Refresh(tok); err != nil {
				return nil, err
			}
			continue
		}
		return resp, nil
	}
	return nil, ErrUnauthorized
}
