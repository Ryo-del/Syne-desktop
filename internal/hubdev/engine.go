package hubdev

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Ryo-del/Syne-protocol/hub"
)

const peerTTL = 30 * time.Second

type peerEntry struct {
	log *hub.Log
	at  time.Time
}

// Engine — устройство Hub: регистрация, проверка реестров, шифрование.
type Engine struct {
	cloud Cloud
	keys  KeyStore
	store Storage
	now   func() time.Time

	mu     sync.Mutex
	data   localData
	device *hub.DeviceKey
	own    *hub.State
	peers  map[string]peerEntry
	trust  *hub.TrustStore
	state  LinkState
	view   atomic.Value // View
}

func New(cloud Cloud, keys KeyStore, store Storage) *Engine {
	e := &Engine{cloud: cloud, keys: keys, store: store, now: time.Now, peers: map[string]peerEntry{}, trust: hub.NewTrustStore()}
	e.data = store.Load()
	e.trust.SetPins(e.data.Pins)
	if raw := keys.Load(); raw != nil {
		if d, err := hub.UnmarshalDeviceKey(raw); err == nil {
			e.device = d
		}
	}
	e.state = NotSetUp
	if e.device != nil && e.data.Login != "" {
		e.state = Ready
		if e.data.PendingCode != "" {
			e.state = Awaiting
		}
	}
	e.publish()
	return e
}

func (e *Engine) persist() {
	e.data.Pins = e.trust.Pins()
	e.store.Save(e.data)
}

func isCode(err error, code string) bool {
	var ce *CodeError
	return errors.As(err, &ce) && ce.Code == code
}

func shortLogin(l string) string { return hub.ShortLogin(l) }

func org(l string) string {
	_, o, _ := strings.Cut(l, "@")
	return o
}

// ── обзор для интерфейса ──

// DeviceView — устройство в реестре.
type DeviceView struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Trusted bool   `json:"trusted"`
	Current bool   `json:"current"`
}

// View — снимок состояния для интерфейса.
type View struct {
	State       LinkState         `json:"state"`
	Login       string            `json:"login"`
	ShortLogin  string            `json:"short_login"`
	SchoolName  string            `json:"school_name"`
	DeviceID    string            `json:"device_id"`
	PairCode    string            `json:"pair_code"`
	Request     string            `json:"request_status"`
	CanApprove  bool              `json:"can_approve"`
	Devices     []DeviceView      `json:"devices"`
	Names       map[string]string `json:"names"`
	Accounts    map[string]string `json:"accounts"`
	Messages    []Message         `json:"messages"`
	RosterKeyID string            `json:"roster_key_id,omitempty"`
}

func (e *Engine) publish() {
	v := View{State: e.state, Login: e.data.Login, ShortLogin: shortLogin(e.data.Login), SchoolName: e.data.SchoolName,
		PairCode: e.data.PendingCode, Request: e.data.RequestStatus, Names: e.data.People, Accounts: e.data.Accounts,
		Messages: append([]Message(nil), e.data.Messages...), Devices: []DeviceView{}}
	if e.device != nil {
		v.DeviceID = e.device.DeviceID()
		if e.own != nil {
			v.CanApprove = e.own.CanApprove(v.DeviceID, e.now()) == nil
		}
	}
	if e.own != nil {
		for _, c := range e.own.ActiveDevices(e.now()) {
			v.Devices = append(v.Devices, DeviceView{ID: c.DeviceID, Name: c.Name, Type: c.DeviceType,
				Trusted: e.own.Devices[c.DeviceID].Trusted, Current: c.DeviceID == v.DeviceID})
		}
	}
	if k := e.data.RosterKeyPending; k != nil {
		v.RosterKeyID = hub.RosterKeyID(k)
	}
	e.view.Store(v)
}

// Snapshot не ждёт сетевых операций.
func (e *Engine) Snapshot() View { return e.view.Load().(View) }

func (e *Engine) State() LinkState { return e.Snapshot().State }

// ── регистрация ──

// connect по аккаунту облака узнаёт логин Hub, создаёт ключ и отправляет запрос на подключение.
func (e *Engine) connect(ctx context.Context, deviceName string) (string, error) {
	login, school, err := e.cloud.Me(ctx)
	if err != nil {
		return "", err
	}
	code, err := e.setUp(ctx, login, deviceName)
	if err != nil {
		return "", err
	}
	e.data.SchoolName = school
	e.persist()
	e.publish()
	return code, nil
}

func (e *Engine) setUp(ctx context.Context, login, deviceName string) (string, error) {
	login = strings.TrimSpace(login)
	if !hub.ValidLogin(login) {
		return "", FormatError("неверный ID")
	}
	key := e.device
	if key == nil {
		var err error
		if key, err = hub.GenerateDeviceKey(); err != nil {
			return "", err
		}
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	req := hub.NewSignedRequest(login, deviceName, DeviceType, key, hex.EncodeToString(b), e.now())
	if err := e.cloud.RequestRegistration(ctx, req); err != nil {
		return "", err
	}
	e.keys.Save(key.Marshal())
	e.device = key
	e.data.Login = login
	e.data.PendingCode = req.PairCode()
	e.data.RequestID = req.RequestID
	e.data.RequestStatus = hub.RequestPending
	e.persist()
	e.state = Awaiting
	e.publish()
	return e.data.PendingCode, nil
}

// CancelRequest — инициатор отменяет запрос и сбрасывает устройство.
func (e *Engine) CancelRequest(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if id := e.data.RequestID; id != "" {
		if err := e.cloud.CancelRequest(ctx, id); err != nil {
			return err
		}
	}
	e.resetLocked()
	return nil
}

// Refresh полностью перепроверяет свой реестр.
func (e *Engine) Refresh(ctx context.Context) (LinkState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.refreshLocked(ctx)
}

func (e *Engine) refreshLocked(ctx context.Context) (LinkState, error) {
	if e.device == nil || e.data.Login == "" {
		return e.state, ErrNotReady
	}
	entries, err := e.cloud.Registry(ctx, e.data.Login, 0)
	if err != nil {
		return e.state, err
	}
	if len(entries) == 0 {
		return e.state, ErrNoHub
	}
	st, err := hub.Replay(entries, hub.DefaultPolicy())
	if err != nil {
		return e.state, err
	}
	e.own = st
	id := e.device.DeviceID()
	if _, err := st.Active(id, e.now()); err == nil {
		e.data.PendingCode = ""
		e.state = Ready
	} else if d := st.Devices[id]; d != nil && d.Revoked {
		e.state = Revoked
	} else if e.state != Awaiting {
		e.state = Awaiting
	}
	if e.state == Awaiting && e.data.RequestID != "" {
		if s, err := e.cloud.RequestStatus(ctx, e.data.RequestID); err == nil {
			e.data.RequestStatus = s
		}
	}
	e.persist()
	e.publish()
	return e.state, nil
}

// Reset стирает ключ и локальные данные (выход, отзыв).
func (e *Engine) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.resetLocked()
}

func (e *Engine) resetLocked() {
	e.keys.Save(nil)
	e.device, e.own = nil, nil
	e.peers = map[string]peerEntry{}
	e.trust = hub.NewTrustStore()
	e.data = localData{}
	e.store.Save(e.data)
	e.state = NotSetUp
	e.publish()
}

// ── допуск в аккаунт ──

// Admission решает, пускать ли человека: только с подтверждённого устройства.
func (e *Engine) Admission(ctx context.Context, deviceName string, force bool) Admission {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch e.state {
	case Ready:
		if force {
			if st, err := e.refreshLocked(ctx); err == nil && st == Revoked {
				return Admission{Status: "revoked"}
			}
		}
		return Admission{Status: "open"}
	case Revoked:
		return Admission{Status: "revoked"}
	case Awaiting:
		st, err := e.refreshLocked(ctx)
		if err == nil {
			switch st {
			case Ready:
				return Admission{Status: "open"}
			case Revoked:
				return Admission{Status: "revoked"}
			}
		}
		switch s := e.data.RequestStatus; s {
		case hub.RequestRejected, hub.RequestExpired, hub.RequestCancelled:
			return Admission{Status: "denied", Detail: s}
		}
		return Admission{Status: "waiting", Code: e.data.PendingCode}
	}
	// NotSetUp
	code, err := e.connect(ctx, deviceName)
	switch {
	case err == nil:
		if st, rerr := e.refreshLocked(ctx); rerr == nil && st == Ready {
			return Admission{Status: "open"}
		}
		return Admission{Status: "waiting", Code: code}
	case isCode(err, "not_bound"), isCode(err, "no_hub"), errors.Is(err, ErrNoHub):
		return Admission{Status: "open"} // аккаунт не привязан к идентичности: защищать нечего
	}
	return Admission{Status: "unreachable"}
}

// ── доверенное устройство ──

func (e *Engine) approverLocked() (*hub.DeviceKey, *hub.State, error) {
	if e.state != Ready || e.device == nil || e.own == nil {
		return nil, nil, ErrNotReady
	}
	if err := e.own.CanApprove(e.device.DeviceID(), e.now()); err != nil {
		return nil, nil, err
	}
	return e.device, e.own, nil
}

// Pending — ожидающие запросы других устройств (только доверенному).
func (e *Engine) Pending(ctx context.Context) ([]hub.PendingRequest, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	d, _, err := e.approverLocked()
	if err != nil {
		return nil, err
	}
	return e.cloud.PendingRequests(ctx, e.data.Login, d)
}

// Approve — «Да» / «Да и сделать доверенным».
func (e *Engine) Approve(ctx context.Context, req hub.CertRequest, trusted bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	d, own, err := e.approverLocked()
	if err != nil {
		return err
	}
	cert, err := d.Endorse(own.HubID, req, e.now(), 0, trusted)
	if err != nil {
		return err
	}
	return e.cloud.PostOp(ctx, hub.CloudOp{Login: e.data.Login, Kind: hub.OpKindApprove, Cert: &cert})
}

func (e *Engine) Reject(ctx context.Context, req hub.CertRequest) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	d, _, err := e.approverLocked()
	if err != nil {
		return err
	}
	dec := d.SignReject(e.data.Login, req.RequestID, req.DeviceID(), e.now())
	return e.cloud.PostOp(ctx, hub.CloudOp{Login: e.data.Login, Kind: hub.OpKindReject, Decision: &dec})
}

func (e *Engine) Promote(ctx context.Context, deviceID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	d, own, err := e.approverLocked()
	if err != nil {
		return err
	}
	p := hub.NewPromotion(own.HubID, deviceID, own.Head.Hash, e.now())
	d.SignPromotion(p)
	return e.cloud.PostOp(ctx, hub.CloudOp{Login: e.data.Login, Kind: hub.OpKindPromote, Promotion: p})
}

func (e *Engine) Revoke(ctx context.Context, deviceID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	d, own, err := e.approverLocked()
	if err != nil {
		return err
	}
	if deviceID == d.DeviceID() {
		return FormatError("нельзя отозвать устройство, с которого вы работаете")
	}
	r := hub.NewRevocation(own.HubID, deviceID, own.Head.Hash, false, e.now())
	r.Sign(d)
	return e.cloud.PostOp(ctx, hub.CloudOp{Login: e.data.Login, Kind: hub.OpKindRevoke, Revocation: r})
}

// ── доверие к собеседникам ──

func (e *Engine) peerLog(ctx context.Context, login string, force bool) (*hub.Log, error) {
	if c, ok := e.peers[login]; ok && !force && e.now().Sub(c.at) < peerTTL {
		return c.log, nil
	}
	entries, err := e.cloud.Registry(ctx, login, 0)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, ErrNoHub
	}
	l, err := hub.LoadLog(entries, hub.DefaultPolicy())
	if err != nil {
		return nil, err
	}
	kind := e.trust.Observe(login, l)
	e.persist()
	switch kind {
	case hub.ChangeReset, hub.ChangeRollback, hub.ChangeFork:
		sn := ""
		if e.own != nil {
			sn = hub.SafetyNumber(e.data.Login, e.own.RootPub, login, l.State().RootPub)
		}
		return nil, &TrustError{Login: login, Kind: string(kind), SafetyNumber: sn}
	}
	e.peers[login] = peerEntry{l, e.now()}
	return l, nil
}

// SafetyNumber — номер безопасности с собеседником.
func (e *Engine) SafetyNumber(ctx context.Context, login string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	entries, err := e.cloud.Registry(ctx, login, 0)
	if err != nil {
		return "", err
	}
	l, err := hub.LoadLog(entries, hub.DefaultPolicy())
	if err != nil {
		return "", err
	}
	if e.own == nil {
		return "", ErrNotReady
	}
	return hub.SafetyNumber(e.data.Login, e.own.RootPub, login, l.State().RootPub), nil
}

// AcceptPeer — человек сверил номер безопасности и принимает новую идентичность.
func (e *Engine) AcceptPeer(ctx context.Context, login string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	entries, err := e.cloud.Registry(ctx, login, 0)
	if err != nil {
		return err
	}
	l, err := hub.LoadLog(entries, hub.DefaultPolicy())
	if err != nil {
		return err
	}
	e.trust.AcceptReset(login, l)
	e.peers[login] = peerEntry{l, e.now()}
	e.persist()
	return nil
}

// ── люди и группы ──

func (e *Engine) RefreshPeople(ctx context.Context) {
	list, err := e.cloud.People(ctx)
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.data.People, e.data.Accounts = map[string]string{}, map[string]string{}
	for _, p := range list {
		if _, ok := e.data.People[p.Login]; !ok {
			e.data.People[p.Login] = p.Name
		}
		for _, id := range p.AccountIDs {
			e.data.Accounts[id] = p.Login
		}
	}
	e.persist()
	e.publish()
}

func (e *Engine) ConfirmRosterKey() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if k := e.data.RosterKeyPending; k != nil {
		e.data.RosterKeyPinned, e.data.RosterKeyPending = k, nil
		e.persist()
		e.publish()
	}
}

func (e *Engine) RejectRosterKey() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.data.RosterKeyPending = nil
	e.persist()
	e.publish()
}

// verifiedRosters — составы групп, проверенные по ключу сервера колледжа. Ключу из облака верить
// можно, только когда человек сверил отпечаток с доверенным устройством.
func (e *Engine) verifiedRosters(ctx context.Context) ([]hub.GroupRoster, error) {
	r, err := e.cloud.Groups(ctx)
	if err != nil {
		return nil, err
	}
	if len(r.Key) == 0 || len(r.Rosters) == 0 {
		return nil, nil
	}
	if !bytes.Equal(e.data.RosterKeyPinned, r.Key) {
		e.data.RosterKeyPending = r.Key
		e.persist()
		e.publish()
		return nil, &RosterKeyError{KeyID: hub.RosterKeyID(r.Key), Changed: e.data.RosterKeyPinned != nil}
	}
	o := org(e.data.Login)
	var out []hub.GroupRoster
	for _, g := range r.Rosters {
		if g.Org == o && hub.VerifyRoster(r.Key, g, e.now()) == nil {
			out = append(out, g)
		}
	}
	return out, nil
}

// ── сообщения ──

func chatContext(a, b string) []byte {
	x, y := shortLogin(a), shortLogin(b)
	if x > y {
		x, y = y, x
	}
	return []byte(x + ":" + y) // как privateChatID в Study
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (e *Engine) requireReady() (*hub.DeviceKey, error) {
	if e.state != Ready || e.device == nil {
		return nil, ErrNotReady
	}
	return e.device, nil
}

// Send шифрует и кладёт сообщение во входящие облака: для устройств собеседника и своих.
func (e *Engine) Send(ctx context.Context, text, peer string) (Message, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if rest, ok := strings.CutPrefix(peer, "group:"); ok {
		id, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return Message{}, FormatError("номер группы")
		}
		return e.sendGroup(ctx, text, id)
	}
	dev, err := e.requireReady()
	if err != nil {
		return Message{}, err
	}
	pl, err := e.peerLog(ctx, peer, false)
	if err != nil {
		return Message{}, err
	}
	rcpts := pl.State().ActiveDevices(e.now())
	if len(rcpts) == 0 {
		return Message{}, FormatError("у получателя нет доверенных устройств")
	}
	if e.own != nil {
		rcpts = append(rcpts, e.own.ActiveDevices(e.now())...)
	}
	env, err := hub.Seal([]byte(text), chatContext(e.data.Login, peer), dev, rcpts)
	if err != nil {
		return Message{}, err
	}
	m := Message{ID: newID(), Peer: peer, From: e.data.Login, Text: text, TS: e.now().Unix(), Outgoing: true}
	if err := e.cloud.PostInbox(ctx, hub.InboxPost{From: e.data.Login, To: peer, Envelope: env, MsgID: m.ID}); err != nil {
		return Message{}, err
	}
	e.data.Messages = append(e.data.Messages, m)
	e.persist()
	e.publish()
	return m, nil
}

func (e *Engine) sendGroup(ctx context.Context, text string, group int64) (Message, error) {
	dev, err := e.requireReady()
	if err != nil {
		return Message{}, err
	}
	rosters, err := e.verifiedRosters(ctx)
	if err != nil {
		return Message{}, err
	}
	var roster *hub.GroupRoster
	for i := range rosters {
		if rosters[i].Group == group {
			roster = &rosters[i]
		}
	}
	if roster == nil {
		return Message{}, FormatError("состав группы не получен или устарел: попробуйте ещё раз")
	}
	if !roster.HasMember(e.data.Login) {
		return Message{}, FormatError("вы не состоите в этой группе")
	}
	var rcpts []hub.Certificate
	for _, member := range roster.Members {
		if member == e.data.Login {
			continue
		}
		l, err := e.peerLog(ctx, member, false)
		var te *TrustError
		if errors.As(err, &te) {
			return Message{}, err // сменилась идентичность участника: нужно решение человека
		}
		if err != nil {
			continue // нет Hub или реестр недоступен
		}
		rcpts = append(rcpts, l.State().ActiveDevices(e.now())...)
	}
	if e.own != nil {
		rcpts = append(rcpts, e.own.ActiveDevices(e.now())...)
	}
	if len(rcpts) == 0 {
		return Message{}, FormatError("у участников группы нет доверенных устройств")
	}
	env, err := hub.Seal([]byte(text), []byte(fmt.Sprintf("grp:%d", group)), dev, rcpts)
	if err != nil {
		return Message{}, err
	}
	m := Message{ID: newID(), Peer: fmt.Sprintf("group:%d", group), From: e.data.Login, Text: text, TS: e.now().Unix(),
		Outgoing: true, GroupName: roster.Name}
	post := hub.InboxPost{From: e.data.Login, Envelope: env, MsgID: m.ID, Group: group, GroupName: roster.Name, Members: roster.Members}
	if err := e.cloud.PostInbox(ctx, post); err != nil {
		return Message{}, err
	}
	e.data.Messages = append(e.data.Messages, m)
	e.persist()
	e.publish()
	return m, nil
}

func unreadable(err error) bool {
	for _, t := range []error{hub.ErrDecrypt, hub.ErrNotForMe, hub.ErrSignature, hub.ErrDeviceRevok, hub.ErrNoDevice, hub.ErrUntrusted} {
		if errors.Is(err, t) {
			return true
		}
	}
	return false
}

// Poll забирает и расшифровывает новые входящие; возвращает новые сообщения.
func (e *Engine) Poll(ctx context.Context) ([]Message, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	dev, err := e.requireReady()
	if err != nil {
		return nil, err
	}
	items, err := e.cloud.FetchInbox(ctx, e.data.Login, e.data.Cursor, dev)
	if err != nil {
		return nil, err
	}
	var fresh []Message
	defer func() { e.persist(); e.publish() }()
	for _, it := range items {
		if e.hasMessage(it.MsgID) {
			e.data.Cursor = it.ID
			continue
		}
		outgoing := it.From == e.data.Login
		peer := it.From
		switch {
		case it.Group != 0:
			peer = fmt.Sprintf("group:%d", it.Group)
		case outgoing:
			peer = it.To
		}
		l, err := e.peerLog(ctx, it.From, false)
		if err != nil {
			var te *TrustError
			if errors.As(err, &te) {
				return fresh, err // курсор не двигаем: ждём решения человека
			}
			if errors.Is(err, ErrNoHub) {
				e.data.Cursor = it.ID
				continue
			}
			return fresh, err // нет связи: повторим позже
		}
		cert, err := l.State().Active(it.Envelope.SenderID, e.now())
		if err == nil {
			var pt []byte
			if pt, err = hub.Open(it.Envelope, dev, *cert); err == nil {
				m := Message{ID: it.MsgID, Peer: peer, From: it.From, Text: string(pt), TS: it.At, Outgoing: outgoing}
				if it.Group != 0 {
					m.GroupName = it.GroupName
				}
				e.data.Messages = append(e.data.Messages, m)
				fresh = append(fresh, m)
			}
		}
		if err != nil && !unreadable(err) {
			return fresh, err
		}
		e.data.Cursor = it.ID
	}
	return fresh, nil
}

func (e *Engine) hasMessage(id string) bool {
	for _, m := range e.data.Messages {
		if m.ID == id {
			return true
		}
	}
	return false
}

// Peers — собеседники, самые свежие первыми.
func (e *Engine) Peers() []string {
	latest := map[string]int64{}
	for _, m := range e.Snapshot().Messages {
		if m.TS > latest[m.Peer] {
			latest[m.Peer] = m.TS
		}
	}
	out := make([]string, 0, len(latest))
	for p := range latest {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return latest[out[i]] > latest[out[j]] })
	return out
}
