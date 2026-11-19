package hubdev

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/Ryo-del/Syne-protocol/hub"
)

// Вложения в защищённых беседах (файл 13): файл шифруется отдельным ключом, блоб лежит в облаке,
// ключ и описание — внутри зашифрованного сообщения.

// Limits — ограничения облака (HUB_BLOB_* в его .env).
type Limits struct {
	Max      int64 `json:"max_bytes"`
	GroupMax int64 `json:"group_max_bytes"`
}

// OffsetError — облако ждёт продолжения загрузки с другого места.
type OffsetError struct{ Received int64 }

func (e *OffsetError) Error() string { return "offset mismatch" }

const uploadChunk = 4 << 20

// SetCacheDir задаёт каталог расшифрованных вложений (очищается при сбросе устройства).
func (e *Engine) SetCacheDir(dir string) { e.cacheDir = dir }

func (e *Engine) cache() string {
	if e.cacheDir != "" {
		return e.cacheDir
	}
	return filepath.Join(os.TempDir(), "syne-hub-cache")
}

func (e *Engine) limits(ctx context.Context) Limits {
	if l, err := e.cloud.Limits(ctx); err == nil && l.Max > 0 {
		return l
	}
	return Limits{Max: 25 << 20, GroupMax: 10 << 20} // значения по умолчанию, если облако не ответило
}

func megabytes(n int64) string { return fmt.Sprintf("%d МБ", n>>20) }

func isPhotoName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".gif":
		return true
	}
	return false
}

// SendFile шифрует файл, загружает блоб и отправляет сообщение-вложение. Движок на это время
// не блокируется: заблокирован он только при чтении состояния и отправке сообщения.
func (e *Engine) SendFile(ctx context.Context, peer, path, caption string) (Message, error) {
	e.mu.Lock()
	dev, err := e.requireReady()
	login := e.data.Login
	e.mu.Unlock()
	if err != nil {
		return Message{}, err
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return Message{}, FormatError("не удалось прочитать файл")
	}
	group := strings.HasPrefix(peer, "group:")
	lim, thumbMax := e.limits(ctx), hub.MaxThumb
	max := lim.Max
	if group {
		max, thumbMax = lim.GroupMax, hub.MaxThumbGroup
	}
	if st.Size() > max {
		return Message{}, FormatError("файл больше допустимого размера (" + megabytes(max) + ")")
	}
	name := filepath.Base(path)
	kind := hub.AttachKindFile
	var thumb []byte
	var w, h int
	if isPhotoName(name) {
		kind = hub.AttachKindPic
		thumb, w, h = makeThumb(path, thumbMax)
	}

	key, err := hub.NewBlobKey()
	if err != nil {
		return Message{}, err
	}
	src, err := os.Open(path)
	if err != nil {
		return Message{}, FormatError("не удалось открыть файл")
	}
	defer src.Close()
	_ = os.MkdirAll(e.cache(), 0o700)
	tmp, err := os.CreateTemp(e.cache(), "send-*.blob")
	if err != nil {
		return Message{}, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	info, err := hub.SealBlob(key, src, tmp)
	if err != nil {
		return Message{}, err
	}
	if err := e.upload(ctx, dev, login, tmp, info); err != nil {
		return Message{}, err
	}

	att := hub.NewAttachment(kind, name, mime.TypeByExtension(strings.ToLower(filepath.Ext(name))), key, info)
	att.Caption, att.Thumb, att.W, att.H = caption, thumb, w, h
	if err := att.Validate(max, thumbMax); err != nil {
		return Message{}, err
	}
	body, err := hub.EncodeAttachment(att)
	if err != nil {
		return Message{}, err
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if _, err := e.requireReady(); err != nil {
		return Message{}, err
	}
	t, err := e.target(ctx, peer)
	if err != nil {
		return Message{}, err
	}
	m, err := e.deliver(ctx, dev, t, body, []string{info.BlobID})
	if err != nil {
		return Message{}, err
	}
	m.Text, m.Att = caption, &att
	e.data.Messages = append(e.data.Messages, m)
	e.persist()
	e.publish()
	return m, nil
}

// upload загружает блоб из f (с докачкой при обрыве и повторе).
func (e *Engine) upload(ctx context.Context, dev *hub.DeviceKey, login string, f *os.File, info hub.BlobInfo) error {
	received, complete, err := e.cloud.BlobStart(ctx, dev, login, info.BlobID, info.EncSize)
	if err != nil {
		return err
	}
	buf := make([]byte, uploadChunk)
	for !complete && received < info.EncSize {
		n, rerr := f.ReadAt(buf, received)
		if n == 0 && rerr != nil {
			return FormatError("не удалось прочитать зашифрованный файл")
		}
		var next int64
		for attempt := 0; ; attempt++ {
			next, err = e.cloud.BlobPut(ctx, dev, login, info.BlobID, info.EncSize, received, buf[:n])
			var oe *OffsetError
			if errors.As(err, &oe) {
				next, err = oe.Received, nil
			}
			if err == nil || attempt >= 3 || ctx.Err() != nil {
				break
			}
		}
		if err != nil {
			return err
		}
		received = next
	}
	return e.cloud.BlobComplete(ctx, dev, login, info.BlobID, info.EncSize)
}

func (e *Engine) attachmentOf(id string) (*hub.Attachment, *hub.DeviceKey, string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	dev, err := e.requireReady()
	if err != nil {
		return nil, nil, "", err
	}
	for _, m := range e.data.Messages {
		if m.ID == id && m.Att != nil {
			a := *m.Att
			return &a, dev, e.data.Login, nil
		}
	}
	return nil, nil, "", FormatError("вложение не найдено")
}

// Fetch скачивает и расшифровывает вложение в кэш; возвращает путь. Повторные вызовы берут кэш.
func (e *Engine) Fetch(ctx context.Context, id string) (string, error) {
	att, dev, login, err := e.attachmentOf(id)
	if err != nil {
		return "", err
	}
	dir := e.cache()
	_ = os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "att-"+att.Blob)
	if st, err := os.Stat(path); err == nil && st.Size() == att.Size {
		return path, nil
	}
	r, err := e.cloud.BlobGet(ctx, dev, login, att.Blob)
	if err != nil {
		return "", err
	}
	defer r.Close()
	tmp := path + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	info, err := hub.OpenBlob(att.Key, r, out)
	cerr := out.Close()
	if err != nil {
		return "", err
	}
	if cerr != nil {
		return "", cerr
	}
	// Блоб и файл должны совпасть с тем, что подписано в сообщении.
	if info.BlobID != att.Blob || info.SHA256 != att.SHA256 || info.Size != att.Size || info.EncSize != att.EncSize {
		return "", FormatError("файл повреждён или подменён")
	}
	return path, os.Rename(tmp, path)
}

// SaveAttachment сохраняет вложение в dest.
func (e *Engine) SaveAttachment(ctx context.Context, id, dest string) error {
	src, err := e.Fetch(ctx, id)
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dest + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return FormatError("не удалось создать файл")
	}
	defer os.Remove(tmp)
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}

// ── миниатюра фото ──

// makeThumb строит JPEG-миниатюру не больше maxBytes (сторона до 256 px); при неудаче — пусто.
func makeThumb(path string, maxBytes int) (data []byte, w, h int) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, 0
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, 0, 0
	}
	b := img.Bounds()
	w, h = b.Dx(), b.Dy()
	for _, side := range []int{256, 192, 128, 96, 64} {
		small := scale(img, side)
		for _, q := range []int{70, 50, 35} {
			var buf bytes.Buffer
			if jpeg.Encode(&buf, small, &jpeg.Options{Quality: q}) == nil && buf.Len() <= maxBytes {
				return buf.Bytes(), w, h
			}
		}
	}
	return nil, w, h
}

// scale уменьшает изображение так, чтобы большая сторона была не больше side (усреднение блоков).
func scale(src image.Image, side int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= side && sh <= side {
		side = max(sw, sh)
	}
	dw, dh := side, side
	if sw >= sh {
		dh = max(1, sh*side/sw)
	} else {
		dw = max(1, sw*side/sh)
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0, y1 := b.Min.Y+y*sh/dh, b.Min.Y+(y+1)*sh/dh
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < dw; x++ {
			x0, x1 := b.Min.X+x*sw/dw, b.Min.X+(x+1)*sw/dw
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, bl, a, n uint64
			for yy := y0; yy < y1; yy++ {
				for xx := x0; xx < x1; xx++ {
					cr, cg, cb, ca := src.At(xx, yy).RGBA()
					r, g, bl, a, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), a+uint64(ca), n+1
				}
			}
			dst.Set(x, y, color.RGBA64{uint16(r / n), uint16(g / n), uint16(bl / n), uint16(a / n)})
		}
	}
	return dst
}
