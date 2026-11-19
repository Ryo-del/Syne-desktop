package hubdev

import (
	"bytes"
	"context"
	"crypto/rand"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Ryo-del/Syne-protocol/hub"
)

func readyEngine(t *testing.T) (*Engine, *fakeCloud, *user, *user) {
	e, fc, alice, bob := setup(t)
	e.SetCacheDir(t.TempDir())
	ctx := context.Background()
	e.Admission(ctx, "ПК", false)
	fc.approve(t, alice, e.data.RequestID, false)
	if a := e.Admission(ctx, "ПК", false); a.Status != "open" {
		t.Fatalf("%+v", a)
	}
	return e, fc, alice, bob
}

func writeTemp(t *testing.T, name string, data []byte) string {
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSendFileReadableByRecipientOnly(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, bob := readyEngine(t)
	data := make([]byte, 300_000) // несколько кусков блоба
	rand.Read(data)
	m, err := e.SendFile(ctx, bob.login, writeTemp(t, "Отчёт.pdf", data), "смотри")
	if err != nil {
		t.Fatal(err)
	}
	if m.Att == nil || m.Text != "смотри" || m.Att.Kind != hub.AttachKindFile {
		t.Fatalf("%+v", m)
	}
	// В интерфейс ключ файла не уходит, а в хранилище остаётся (нужен для скачивания).
	for _, vm := range e.Snapshot().Messages {
		if vm.Att != nil && vm.Att.Key != nil {
			t.Fatal("ключ файла не должен попадать в снимок для интерфейса")
		}
	}
	if len(e.data.Messages[0].Att.Key) != hub.BlobKeySize {
		t.Fatal("ключ файла потерян")
	}

	// Study Боба: расшифровывает конверт, видит вложение, скачивает и расшифровывает блоб.
	it := fc.inbox[0]
	pt, err := hub.Open(it.Envelope, bob.study, bobCert(t, alice, it))
	if err != nil {
		t.Fatal(err)
	}
	att, err := hub.DecodeAttachment(pt)
	if err != nil || att.Name != "Отчёт.pdf" || att.Caption != "смотри" {
		t.Fatalf("%+v %v", att, err)
	}
	r, err := fc.BlobGet(ctx, bob.study, bob.login, att.Blob)
	if err != nil {
		t.Fatal(err)
	}
	var plain bytes.Buffer
	if _, err := hub.OpenBlob(att.Key, r, &plain); err != nil || !bytes.Equal(plain.Bytes(), data) {
		t.Fatalf("Боб не прочитал файл: %v", err)
	}
	// Постороннему облако блоб не отдаёт.
	if _, err := fc.BlobGet(ctx, bob.study, "carol@org1", att.Blob); err == nil {
		t.Fatal("доступа у постороннего быть не должно")
	}
}

func TestReceiveFetchSaveAndTamper(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, bob := readyEngine(t)
	data := make([]byte, 150_000)
	rand.Read(data)
	key, _ := hub.NewBlobKey()
	var blob bytes.Buffer
	info, _ := hub.SealBlob(key, bytes.NewReader(data), &blob)
	fc.BlobStart(ctx, bob.study, bob.login, info.BlobID, info.EncSize)
	fc.BlobPut(ctx, bob.study, bob.login, info.BlobID, info.EncSize, 0, blob.Bytes())
	fc.BlobComplete(ctx, bob.study, bob.login, info.BlobID, info.EncSize)

	att := hub.NewAttachment(hub.AttachKindFile, "данные.bin", "", key, info)
	body, _ := hub.EncodeAttachment(att)
	env, _ := hub.Seal(body, chatContext(alice.login, bob.login), bob.study, alice.log.State().ActiveDevices(time.Now()))
	_ = fc.PostInbox(ctx, hub.InboxPost{From: bob.login, To: alice.login, Envelope: env, MsgID: "a1", Blobs: []string{info.BlobID}})
	fc.access[info.BlobID][alice.login] = true

	fresh, err := e.Poll(ctx)
	if err != nil || len(fresh) != 1 || fresh[0].Att == nil || fresh[0].Att.Name != "данные.bin" {
		t.Fatalf("Desktop должен получить вложение: %+v %v", fresh, err)
	}
	dest := filepath.Join(t.TempDir(), "out.bin")
	if err := e.SaveAttachment(ctx, "a1", dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); !bytes.Equal(got, data) {
		t.Fatal("сохранён другой файл")
	}
	if _, err := os.Stat(dest + ".part"); err == nil {
		t.Fatal("временный файл должен исчезнуть")
	}

	// Подмена блоба в облаке: расшифровка не проходит, файла в кэше нет.
	e.Reset()
	if entries, _ := os.ReadDir(e.cache()); len(entries) != 0 {
		t.Fatal("кэш вложений очищается при сбросе устройства")
	}
}

func TestTamperedBlobIsRejected(t *testing.T) {
	ctx := context.Background()
	e, fc, alice, bob := readyEngine(t)
	data := make([]byte, 90_000)
	rand.Read(data)
	key, _ := hub.NewBlobKey()
	var blob bytes.Buffer
	info, _ := hub.SealBlob(key, bytes.NewReader(data), &blob)
	bad := blob.Bytes()
	bad[len(bad)/2] ^= 1
	fc.BlobStart(ctx, bob.study, bob.login, info.BlobID, info.EncSize)
	fc.BlobPut(ctx, bob.study, bob.login, info.BlobID, info.EncSize, 0, bad)
	fc.BlobComplete(ctx, bob.study, bob.login, info.BlobID, info.EncSize)
	att := hub.NewAttachment(hub.AttachKindFile, "x.bin", "", key, info)
	body, _ := hub.EncodeAttachment(att)
	env, _ := hub.Seal(body, chatContext(alice.login, bob.login), bob.study, alice.log.State().ActiveDevices(time.Now()))
	_ = fc.PostInbox(ctx, hub.InboxPost{From: bob.login, To: alice.login, Envelope: env, MsgID: "t1", Blobs: []string{info.BlobID}})
	fc.access[info.BlobID][alice.login] = true
	if _, err := e.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Fetch(ctx, "t1"); err == nil {
		t.Fatal("испорченный блоб должен отклоняться")
	}
}

func TestSendFileLimitsAndPhotoThumb(t *testing.T) {
	ctx := context.Background()
	e, _, _, bob := readyEngine(t)
	big := make([]byte, 1<<20+1) // лимит подменённого облака — 1 МБ
	if _, err := e.SendFile(ctx, bob.login, writeTemp(t, "big.bin", big), ""); err == nil {
		t.Fatal("файл больше предела должен отклоняться до шифрования")
	}
	if _, err := e.SendFile(ctx, bob.login, t.TempDir(), ""); err == nil {
		t.Fatal("папку отправить нельзя")
	}
	img := image.NewRGBA(image.Rect(0, 0, 800, 600))
	for x := 0; x < 800; x++ {
		for y := 0; y < 600; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var pic bytes.Buffer
	png.Encode(&pic, img)
	m, err := e.SendFile(ctx, bob.login, writeTemp(t, "фото.png", pic.Bytes()), "")
	if err != nil {
		t.Fatal(err)
	}
	a := m.Att
	if a.Kind != hub.AttachKindPic || len(a.Thumb) == 0 || len(a.Thumb) > hub.MaxThumb || a.W != 800 || a.H != 600 {
		t.Fatalf("миниатюра фото: kind=%s thumb=%d %dx%d", a.Kind, len(a.Thumb), a.W, a.H)
	}
}
