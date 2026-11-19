package hubdev

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// FileStorage — локальные данные Hub в файле (права только владельцу, запись атомарная).
type FileStorage struct{ Path string }

func (s FileStorage) Load() localData {
	var d localData
	if raw, err := os.ReadFile(s.Path); err == nil {
		_ = json.Unmarshal(raw, &d)
	}
	return d
}

func (s FileStorage) Save(d localData) {
	raw, err := json.Marshal(d)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.Path), 0o700)
	tmp := s.Path + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, s.Path)
	}
}

// KeyringStore — ключ устройства в связке ключей ОС (Windows Credential Manager).
type KeyringStore struct{ Account string }

const keyringService = "syne-desktop-hub"

func (k KeyringStore) Load() []byte {
	v, err := keyring.Get(keyringService, k.Account)
	if err != nil {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil
	}
	return raw
}

func (k KeyringStore) Save(raw []byte) {
	if raw == nil {
		_ = keyring.Delete(keyringService, k.Account)
		return
	}
	_ = keyring.Set(keyringService, k.Account, base64.StdEncoding.EncodeToString(raw))
}
