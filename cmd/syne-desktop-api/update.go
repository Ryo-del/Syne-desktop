package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/Ryo-del/Syne-Desktop/internal/update"
)

// defaultWebURL — Syne Web, откуда берутся подписанные манифесты обновлений (можно переопределить SYNE_WEB_URL).
const defaultWebURL = "https://syne-network.ru"

// updateService — обновления приложения. nil, если версия неизвестна (разработка) или адрес Syne Web неверный.
type updateService struct {
	m *update.Manager
	s *server
}

func newUpdateService(s *server, version, webURL string) *updateService {
	if version == "" {
		return nil
	}
	if webURL == "" {
		webURL = os.Getenv("SYNE_WEB_URL")
	}
	if webURL == "" {
		webURL = defaultWebURL
	}
	m, err := update.New(webURL, filepath.Join(dataDir(), "updates"), version)
	if err != nil {
		log.Printf("обновления отключены: %v", err)
		return nil
	}
	return &updateService{m: m, s: s}
}

// run — фоновая проверка. Автоустановка ждёт, пока завершатся передачи файлов.
func (u *updateService) run(ctx context.Context) {
	u.m.Run(ctx, u.busy, func() {
		log.Printf("запущен установщик обновления, sidecar завершается")
		exitSoon()
	})
}

func (u *updateService) busy() bool {
	for _, j := range u.s.jobs.Snapshot() {
		if j.State == "running" {
			return true
		}
	}
	return false
}

// exitSoon даёт ответу уйти в интерфейс и завершает процесс: установщик заменяет файлы sidecar.
func exitSoon() {
	go func() { time.Sleep(1500 * time.Millisecond); os.Exit(0) }()
}

type updateState struct {
	Available bool            `json:"available"` // механизм обновлений работает
	Current   string          `json:"current"`
	Settings  update.Settings `json:"settings"`
	update.Snapshot
	Busy bool `json:"busy"` // идут передачи файлов
}

func (u *updateService) state() updateState {
	return updateState{Available: true, Current: u.m.CurrentVersion(), Settings: u.m.Settings(), Snapshot: u.m.Snapshot(), Busy: u.busy()}
}

func (u *updateService) register(mux *http.ServeMux) {
	mux.HandleFunc("/update", func(w http.ResponseWriter, r *http.Request) {
		if u == nil {
			writeJSON(w, 200, updateState{Available: false})
			return
		}
		writeJSON(w, 200, u.state())
	})
	mux.HandleFunc("/update/check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || u == nil {
			http.Error(w, "not available", http.StatusNotFound)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		_ = u.m.Check(ctx) // ошибка попадает в состояние
		writeJSON(w, 200, u.state())
	})
	mux.HandleFunc("/update/settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || u == nil {
			http.Error(w, "not available", http.StatusNotFound)
			return
		}
		var in update.Settings
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad_request", "message": "Неверные настройки."})
			return
		}
		if err := u.m.SetSettings(in); err != nil {
			writeJSON(w, 500, map[string]string{"error": "save_failed", "message": err.Error()})
			return
		}
		writeJSON(w, 200, u.state())
	})
	mux.HandleFunc("/update/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || u == nil {
			http.Error(w, "not available", http.StatusNotFound)
			return
		}
		if err := u.m.Install(); err != nil {
			writeJSON(w, 409, map[string]string{"error": "install_failed", "message": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"installing": true})
		exitSoon()
	})
}
