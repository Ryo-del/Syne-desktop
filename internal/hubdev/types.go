// Пакет hubdev — Syne Key Hub на устройстве-десктопе. Повторяет движок iOS (Core/Hub/HubEngine.swift):
// ключ устройства только здесь, запрос на подключение через облако, подтверждает доверенное устройство,
// сообщения шифруются на устройства получателя и свои. Криптография — пакет Syne-protocol/hub.
package hubdev

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/Ryo-del/Syne-protocol/hub"
)

// DeviceType — тип устройства в сертификатах.
const DeviceType = hub.TypeDesktop

// Message — расшифрованное сообщение.
type Message struct {
	ID        string `json:"id"`
	Peer      string `json:"peer"` // login@org собеседника или group:<id>
	From      string `json:"from"`
	Text      string `json:"text"`
	TS        int64  `json:"ts"`
	Outgoing  bool   `json:"outgoing"`
	GroupName string `json:"group_name,omitempty"`
	// Att — вложение. Ключ файла хранится только локально и в интерфейс не отдаётся.
	Att *hub.Attachment `json:"att,omitempty"`
}

// Person — человек школы с Hub.
type Person struct {
	Login      string   `json:"login"`
	Name       string   `json:"name"`
	AccountIDs []string `json:"account_ids,omitempty"`
}

// GroupsResponse — подписанные составы групп и ключ сервера колледжа.
type GroupsResponse struct {
	Key     []byte            `json:"key"`
	Rosters []hub.GroupRoster `json:"rosters"`
}

// Cloud — то, что Hub берёт у Syne Cloud. В приложении — HTTPS, в тестах — подмена.
type Cloud interface {
	Me(ctx context.Context) (login, school string, err error)
	People(ctx context.Context) ([]Person, error)
	Groups(ctx context.Context) (GroupsResponse, error)
	Registry(ctx context.Context, login string, after uint64) ([]hub.Entry, error)
	RequestRegistration(ctx context.Context, req hub.CertRequest) error
	RequestStatus(ctx context.Context, requestID string) (string, error)
	CancelRequest(ctx context.Context, requestID string) error
	PendingRequests(ctx context.Context, login string, key *hub.DeviceKey) ([]hub.PendingRequest, error)
	PostOp(ctx context.Context, op hub.CloudOp) error
	PostInbox(ctx context.Context, p hub.InboxPost) error
	FetchInbox(ctx context.Context, login string, after int64, key *hub.DeviceKey) ([]hub.InboxItem, error)

	// Вложения (файл 13).
	Limits(ctx context.Context) (Limits, error)
	BlobStart(ctx context.Context, key *hub.DeviceKey, login, id string, size int64) (received int64, complete bool, err error)
	BlobPut(ctx context.Context, key *hub.DeviceKey, login, id string, size, offset int64, data []byte) (received int64, err error)
	BlobComplete(ctx context.Context, key *hub.DeviceKey, login, id string, size int64) error
	BlobGet(ctx context.Context, key *hub.DeviceKey, login, id string) (io.ReadCloser, error)
}

// KeyStore хранит ключ устройства (связка ключей ОС).
type KeyStore interface {
	Load() []byte
	Save(raw []byte) // nil — удалить
}

// localData — локальные данные Hub пользователя.
type localData struct {
	People           map[string]string  `json:"people,omitempty"`
	Accounts         map[string]string  `json:"accounts,omitempty"`
	SchoolName       string             `json:"school_name,omitempty"`
	RequestID        string             `json:"request_id,omitempty"`
	RequestStatus    string             `json:"request_status,omitempty"`
	Login            string             `json:"login,omitempty"`
	PendingCode      string             `json:"pending_code,omitempty"`
	Pins             map[string]hub.Pin `json:"pins,omitempty"`
	RosterKeyPinned  []byte             `json:"roster_key_pinned,omitempty"`
	RosterKeyPending []byte             `json:"roster_key_pending,omitempty"`
	Cursor           int64              `json:"cursor,omitempty"`
	Messages         []Message          `json:"messages,omitempty"`
}

// Storage хранит localData.
type Storage interface {
	Load() localData
	Save(localData)
}

// Состояния связи устройства с Hub.
type LinkState string

const (
	NotSetUp LinkState = "not_set_up"
	Awaiting LinkState = "awaiting"
	Ready    LinkState = "ready"
	Revoked  LinkState = "revoked"
)

// Admission — решение «пускать ли человека в аккаунт на этом устройстве».
type Admission struct {
	Status string `json:"status"`           // open | waiting | denied | revoked | unreachable
	Code   string `json:"code,omitempty"`   // код сопряжения для экрана
	Detail string `json:"detail,omitempty"` // для denied: rejected | expired | cancelled
}

// Ошибки.
var (
	ErrNotReady = errors.New("устройство ещё не подключено к Key Hub")
	ErrNoHub    = errors.New("у пользователя нет Key Hub")
)

// CodeError — ошибка облака с кодом (not_bound, no_hub...).
type CodeError struct {
	Code, Message string
	Status        int
	Received      int64 // для offset_mismatch
}

func (e *CodeError) Error() string { return e.Message }

// FormatError — ошибка в данных пользователя («у получателя нет доверенных устройств»).
type FormatError string

func (e FormatError) Error() string { return string(e) }

// TrustError — у собеседника сменилась идентичность: нужно решение человека.
type TrustError struct {
	Login        string `json:"login"`
	Kind         string `json:"kind"` // reset | rollback | fork
	SafetyNumber string `json:"safety_number"`
}

func (e *TrustError) Error() string {
	short := hub.ShortLogin(e.Login)
	switch e.Kind {
	case string(hub.ChangeReset):
		return fmt.Sprintf("У %s сменилась идентичность. Сверьте номер безопасности.", short)
	case string(hub.ChangeRollback):
		return fmt.Sprintf("Реестр устройств %s откатился назад.", short)
	}
	return fmt.Sprintf("Реестр устройств %s не совпадает с запомненным.", short)
}

// RosterKeyError — ключ сервера колледжа ждёт сверки отпечатка.
type RosterKeyError struct {
	KeyID   string `json:"key_id"`
	Changed bool   `json:"changed"`
}

func (e *RosterKeyError) Error() string {
	return "Нужно сверить отпечаток ключа сервера колледжа."
}
