package hubdev

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/Ryo-del/Syne-protocol/hub"
)

type memKeys struct{ raw []byte }

func (m *memKeys) Load() []byte  { return m.raw }
func (m *memKeys) Save(r []byte) { m.raw = r }

type memStore struct{ d localData }

func (m *memStore) Load() localData  { return m.d }
func (m *memStore) Save(d localData) { m.d = d }

// user — человек со Study-устройством (поручитель) и реестром в «облаке».
type user struct {
	login string
	study *hub.DeviceKey
	log   *hub.Log
}

func newUser(t *testing.T, login string) *user {
	root, _ := hub.GenerateRootKey()
	dev, _ := hub.GenerateDeviceKey()
	req := hub.NewSignedRequest(login, "Study", hub.TypeStudy, dev, "c", time.Now())
	l, err := hub.NewLog(root, login, req, "", time.Now(), hub.DefaultPolicy())
	if err != nil {
		t.Fatal(err)
	}
	return &user{login, dev, l}
}

// fakeCloud — Syne Cloud для одного Desktop: реестры, запросы в Holding, входящие.
type fakeCloud struct {
	mu       sync.Mutex
	users    map[string]*user
	me       string
	reqs     map[string]hub.CertRequest
	status   map[string]string
	inbox    []hub.InboxItem
	nextID   int64
	notBound bool

	blobs    map[string][]byte
	complete map[string]bool
	access   map[string]map[string]bool
}

func (f *fakeCloud) Me(ctx context.Context) (string, string, error) {
	if f.notBound {
		return "", "", &CodeError{Code: "not_bound", Message: "x", Status: 404}
	}
	return f.me, "Колледж", nil
}
func (f *fakeCloud) People(context.Context) ([]Person, error) { return nil, nil }
func (f *fakeCloud) Groups(context.Context) (GroupsResponse, error) {
	return GroupsResponse{}, nil
}
func (f *fakeCloud) Registry(_ context.Context, login string, _ uint64) ([]hub.Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u := f.users[login]
	if u == nil {
		return nil, nil
	}
	return append([]hub.Entry(nil), u.log.Entries...), nil
}
func (f *fakeCloud) RequestRegistration(_ context.Context, r hub.CertRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := r.Verify(time.Now()); err != nil {
		return err
	}
	f.reqs[r.RequestID], f.status[r.RequestID] = r, hub.RequestPending
	return nil
}
func (f *fakeCloud) RequestStatus(_ context.Context, id string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status[id], nil
}
func (f *fakeCloud) CancelRequest(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status[id] = hub.RequestCancelled
	return nil
}
func (f *fakeCloud) PendingRequests(context.Context, string, *hub.DeviceKey) ([]hub.PendingRequest, error) {
	return nil, nil
}
func (f *fakeCloud) PostOp(context.Context, hub.CloudOp) error { return nil }
func (f *fakeCloud) PostInbox(_ context.Context, p hub.InboxPost) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	for _, b := range p.Blobs {
		if f.access[b] == nil {
			f.access[b] = map[string]bool{}
		}
		f.access[b][p.From] = true
		f.access[b][p.To] = true
	}
	f.inbox = append(f.inbox, hub.InboxItem{ID: f.nextID, From: p.From, To: p.To, MsgID: p.MsgID, Envelope: p.Envelope, At: time.Now().Unix()})
	return nil
}
func (f *fakeCloud) FetchInbox(_ context.Context, login string, after int64, _ *hub.DeviceKey) ([]hub.InboxItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []hub.InboxItem
	for _, it := range f.inbox {
		if it.ID > after && (it.To == login || it.From == login) {
			out = append(out, it)
		}
	}
	return out, nil
}

// approve — Study подтверждает запрос; «сервер колледжа» применяет сертификат к реестру.
func (f *fakeCloud) approve(t *testing.T, u *user, reqID string, trusted bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cert, err := u.study.Endorse(u.log.State().HubID, f.reqs[reqID], time.Now(), 0, trusted)
	if err != nil {
		t.Fatal(err)
	}
	if err := u.log.AddDevice(cert); err != nil {
		t.Fatal(err)
	}
	f.status[reqID] = hub.RequestApproved
}

func setup(t *testing.T) (*Engine, *fakeCloud, *user, *user) {
	alice, bob := newUser(t, "alice@org1"), newUser(t, "bob@org1")
	fc := &fakeCloud{users: map[string]*user{alice.login: alice, bob.login: bob}, me: alice.login,
		reqs: map[string]hub.CertRequest{}, status: map[string]string{}}
	return New(fc, &memKeys{}, &memStore{}), fc, alice, bob
}

func TestRegistrationAndMessaging(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, bob := setup(t)

	a := e.Admission(ctx, "ПК", false)
	if a.Status != "waiting" || len(a.Code) != 6 {
		t.Fatalf("после запроса нужно ждать подтверждения с кодом: %+v", a)
	}
	if _, err := e.Send(ctx, "рано", bob.login); !errors.Is(err, ErrNotReady) {
		t.Fatalf("до подтверждения писать нельзя, получено %v", err)
	}
	if got := e.Admission(ctx, "ПК", false); got.Status != "waiting" {
		t.Fatalf("без подтверждения всё ещё ждём: %+v", got)
	}

	fc.approve(t, alice, e.data.RequestID, false)
	if a := e.Admission(ctx, "ПК", false); a.Status != "open" {
		t.Fatalf("после подтверждения должен пустить: %+v", a)
	}
	v := e.Snapshot()
	if v.State != Ready || v.CanApprove || len(v.Devices) != 2 {
		t.Fatalf("привязанное устройство не доверенное, в реестре два устройства: %+v", v)
	}

	// Desktop → Bob: Study Боба читает, чужой — нет.
	if _, err := e.Send(ctx, "привет, Боб", bob.login); err != nil {
		t.Fatal(err)
	}
	it := fc.inbox[0]
	pt, err := hub.Open(it.Envelope, bob.study, bobCert(t, alice, it))
	if err != nil || string(pt) != "привет, Боб" {
		t.Fatalf("Study Боба должен прочитать: %q %v", pt, err)
	}
	// Своё Study-устройство тоже читает (сообщение на все устройства отправителя).
	if _, err := hub.Open(it.Envelope, alice.study, bobCert(t, alice, it)); err != nil {
		t.Fatalf("свои устройства должны читать: %v", err)
	}

	// Bob → Alice: Desktop расшифровывает.
	aliceDevs := alice.log.State().ActiveDevices(time.Now())
	env, err := hub.Seal([]byte("привет, Алиса"), chatContext(alice.login, bob.login), bob.study, aliceDevs)
	if err != nil {
		t.Fatal(err)
	}
	_ = fc.PostInbox(ctx, hub.InboxPost{From: bob.login, To: alice.login, Envelope: env, MsgID: "m2"})
	fresh, err := e.Poll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range fresh {
		got = append(got, m.Text)
	}
	if len(got) != 1 || got[0] != "привет, Алиса" {
		t.Fatalf("Desktop должен получить ответ Боба, получено %q", got)
	}
	// Повторный опрос не дублирует.
	if again, _ := e.Poll(ctx); len(again) != 0 {
		t.Fatalf("дубли: %v", again)
	}
	if n := len(e.Snapshot().Messages); n != 2 {
		t.Fatalf("в истории два сообщения, а не %d", n)
	}
}

// bobCert — сертификат отправителя из реестра (как делает получатель).
func bobCert(t *testing.T, sender *user, it hub.InboxItem) hub.Certificate {
	c, err := sender.log.State().Active(it.Envelope.SenderID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return *c
}

func TestPeerIdentityResetBlocksSending(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, bob := setup(t)
	e.Admission(ctx, "ПК", false)
	fc.approve(t, alice, e.data.RequestID, false)
	e.Admission(ctx, "ПК", false)
	if _, err := e.Send(ctx, "первый", bob.login); err != nil {
		t.Fatal(err)
	}
	// У Боба новая идентичность (сброс): другой Hub под тем же логином.
	fc.users[bob.login] = newUser(t, bob.login)
	e.peers = map[string]peerEntry{}
	_, err := e.Send(ctx, "второй", bob.login)
	var te *TrustError
	if !errors.As(err, &te) || te.Kind != "reset" || te.SafetyNumber == "" {
		t.Fatalf("смена идентичности должна блокировать отправку: %v", err)
	}
	if err := e.AcceptPeer(ctx, bob.login); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Send(ctx, "после сверки", bob.login); err != nil {
		t.Fatalf("после сверки отправка разрешена: %v", err)
	}
}

func TestRevokedDeviceIsLockedOut(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, _ := setup(t)
	e.Admission(ctx, "ПК", false)
	fc.approve(t, alice, e.data.RequestID, true)
	e.Admission(ctx, "ПК", false)
	if !e.Snapshot().CanApprove {
		t.Fatal("устройство подтверждено как доверенное")
	}
	r := hub.NewRevocation(alice.log.State().HubID, e.device.DeviceID(), alice.log.State().Head.Hash, false, time.Now())
	r.Sign(alice.study)
	if err := alice.log.Revoke(r); err != nil {
		t.Fatal(err)
	}
	if a := e.Admission(ctx, "ПК", true); a.Status != "revoked" {
		t.Fatalf("отозванное устройство должно быть закрыто: %+v", a)
	}
}

func TestNotBoundAccountIsOpen(t *testing.T) {
	e, fc, _, _ := setup(t)
	fc.notBound = true
	if a := e.Admission(context.Background(), "ПК", false); a.Status != "open" {
		t.Fatalf("аккаунт без Hub защищать нечем: %+v", a)
	}
}

func TestCancelAndRestartPersist(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, _ := setup(t)
	keys, store := e.keys.(*memKeys), e.store.(*memStore)
	e.Admission(ctx, "ПК", false)
	// Перезапуск приложения: состояние восстанавливается из хранилищ.
	e2 := New(fc, keys, store)
	if e2.State() != Awaiting {
		t.Fatalf("после перезапуска ждём подтверждения: %s", e2.State())
	}
	fc.approve(t, alice, e2.data.RequestID, false)
	if a := e2.Admission(ctx, "ПК", false); a.Status != "open" {
		t.Fatalf("%+v", a)
	}
	if err := e2.CancelRequest(ctx); err != nil {
		t.Fatal(err)
	}
	if e2.State() != NotSetUp || keys.raw != nil {
		t.Fatal("после отмены ключ и состояние стёрты")
	}
}

// ── вложения в подменённом облаке ──

func (f *fakeCloud) Limits(context.Context) (Limits, error) {
	return Limits{Max: 1 << 20, GroupMax: 1 << 19}, nil
}

func (f *fakeCloud) BlobStart(_ context.Context, _ *hub.DeviceKey, _, id string, size int64) (int64, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.blobs == nil {
		f.blobs, f.complete, f.access = map[string][]byte{}, map[string]bool{}, map[string]map[string]bool{}
	}
	return int64(len(f.blobs[id])), f.complete[id], nil
}

func (f *fakeCloud) BlobPut(_ context.Context, _ *hub.DeviceKey, _, id string, _, offset int64, data []byte) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if offset != int64(len(f.blobs[id])) {
		return 0, &OffsetError{Received: int64(len(f.blobs[id]))}
	}
	f.blobs[id] = append(f.blobs[id], data...)
	return int64(len(f.blobs[id])), nil
}

func (f *fakeCloud) BlobComplete(_ context.Context, _ *hub.DeviceKey, _, id string, _ int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.complete[id] = true
	return nil
}

func (f *fakeCloud) BlobGet(_ context.Context, _ *hub.DeviceKey, login, id string) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.complete[id] || !f.access[id][login] {
		return nil, &CodeError{Code: "not_found", Message: "нет доступа", Status: 404}
	}
	return io.NopCloser(bytes.NewReader(f.blobs[id])), nil
}
