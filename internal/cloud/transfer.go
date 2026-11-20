package cloud

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// Job — загрузка или скачивание файла; интерфейс опрашивает его состояние.
type Job struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // upload | download
	Name  string `json:"name"`
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
	State string `json:"state"` // running | done | error | cancelled
	Error string `json:"error,omitempty"`

	cancel chan struct{}
}

// Jobs — реестр передач.
type Jobs struct {
	mu   sync.Mutex
	list map[string]*Job
	seq  int
}

func NewJobs() *Jobs { return &Jobs{list: map[string]*Job{}} }

func (j *Jobs) add(kind, name string, total int64) *Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.seq++
	job := &Job{ID: strconv.Itoa(j.seq), Kind: kind, Name: name, Total: total, State: "running", cancel: make(chan struct{})}
	j.list[job.ID] = job
	return job
}

func (j *Jobs) update(job *Job, fn func(*Job)) {
	j.mu.Lock()
	fn(job)
	j.mu.Unlock()
}

func (j *Jobs) Snapshot() []Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]Job, 0, len(j.list))
	for _, v := range j.list {
		out = append(out, Job{ID: v.ID, Kind: v.Kind, Name: v.Name, Done: v.Done, Total: v.Total, State: v.State, Error: v.Error})
	}
	return out
}

func (j *Jobs) Cancel(id string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if job := j.list[id]; job != nil && job.State == "running" {
		close(job.cancel)
		job.State = "cancelled"
	}
}

// Clear убирает завершённые передачи из списка.
func (j *Jobs) Clear() {
	j.mu.Lock()
	defer j.mu.Unlock()
	for id, v := range j.list {
		if v.State != "running" {
			delete(j.list, id)
		}
	}
}

func (j *Jobs) fail(job *Job, err error) {
	j.update(job, func(x *Job) {
		if x.State == "cancelled" {
			return
		}
		x.State, x.Error = "error", err.Error()
	})
}

func (j *Jobs) cancelled(job *Job) bool {
	select {
	case <-job.cancel:
		return true
	default:
		return false
	}
}

type uploadStatus struct {
	ID        string `json:"id"`
	Size      int64  `json:"size"`
	Received  int64  `json:"received"`
	ChunkSize int64  `json:"chunk_size"`
}

type uploadResult struct {
	Upload   *uploadStatus `json:"upload"`
	Conflict bool          `json:"conflict"`
}

func apiError(resp *http.Response) error {
	var body struct{ Error, Message string }
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body)
	msg := body.Message
	switch {
	case resp.StatusCode == 507:
		msg = "Не хватает места в облаке."
	case msg == "":
		msg = fmt.Sprintf("Ошибка сервера (%d)", resp.StatusCode)
	}
	return &Error{Status: resp.StatusCode, Code: body.Error, Message: msg}
}

// Upload отправляет файл чанками с докачкой при обрыве. parentID пустой — корень.
func (c *Client) Upload(jobs *Jobs, path, parentID string) *Job {
	return c.upload2(jobs, path, parentID, "", 0)
}

// UploadVersion заменяет содержимое существующего файла новой версией (fileID, версия, которую видел клиент).
func (c *Client) UploadVersion(jobs *Jobs, path, fileID string, baseVersion int) *Job {
	return c.upload2(jobs, path, "", fileID, baseVersion)
}

func (c *Client) upload2(jobs *Jobs, path, parentID, fileID string, baseVersion int) *Job {
	st, err := os.Stat(path)
	job := jobs.add("upload", filepath.Base(path), 0)
	if err != nil || st.IsDir() {
		jobs.fail(job, fmt.Errorf("Не удалось прочитать файл."))
		return job
	}
	jobs.update(job, func(x *Job) { x.Total = st.Size() })
	go func() {
		if err := c.upload(jobs, job, path, parentID, fileID, baseVersion, st.Size()); err != nil {
			jobs.fail(job, err)
			return
		}
		jobs.update(job, func(x *Job) {
			if x.State == "running" {
				x.State, x.Done = "done", x.Total
			}
		})
	}()
	return job
}

func (c *Client) upload(jobs *Jobs, job *Job, path, parentID, fileID string, baseVersion int, size int64) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("Не удалось открыть файл.")
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("Не удалось прочитать файл.")
	}
	sum := hex.EncodeToString(h.Sum(nil))

	req := map[string]any{"name": filepath.Base(path), "size": size, "sha256": sum, "device": c.DeviceName}
	if fileID != "" {
		req["file_id"], req["base_version"] = fileID, baseVersion
	} else if parentID != "" {
		req["parent_id"] = parentID
	}
	body, _ := json.Marshal(req)
	resp, err := c.Do("POST", "uploads", "", http.Header{"Content-Type": {"application/json"}}, bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		return nil // такое содержимое уже есть в облаке
	}
	if resp.StatusCode != 201 {
		return apiError(resp)
	}
	var res uploadResult
	if json.NewDecoder(resp.Body).Decode(&res) != nil || res.Upload == nil {
		return fmt.Errorf("Не удалось разобрать ответ сервера.")
	}
	up := res.Upload
	chunk := up.ChunkSize
	if chunk <= 0 || chunk > 8<<20 {
		chunk = 4 << 20
	}
	offset := up.Received
	buf := make([]byte, chunk)
	for offset < size {
		if jobs.cancelled(job) {
			_, _ = c.doClose("DELETE", "uploads/"+up.ID, "", nil)
			return nil
		}
		n, err := f.ReadAt(buf, offset)
		if n == 0 && err != nil {
			return fmt.Errorf("Не удалось прочитать файл.")
		}
		var st *uploadStatus
		for attempt := 0; ; attempt++ {
			r, err := c.Do("PUT", "uploads/"+up.ID, "offset="+strconv.FormatInt(offset, 10),
				http.Header{"Content-Type": {"application/octet-stream"}}, bytes.NewReader(buf[:n]))
			if err != nil {
				if attempt < 3 {
					continue
				}
				return err
			}
			if r.StatusCode == 409 { // сервер уже получил больше или меньше: продолжаем с его позиции
				var e struct{ Upload *uploadStatus }
				_ = json.NewDecoder(r.Body).Decode(&e)
				r.Body.Close()
				if e.Upload == nil {
					return fmt.Errorf("Загрузка прервана.")
				}
				st = e.Upload
				break
			}
			if r.StatusCode != 200 {
				err := apiError(r)
				r.Body.Close()
				return err
			}
			st = &uploadStatus{}
			_ = json.NewDecoder(r.Body).Decode(st)
			r.Body.Close()
			break
		}
		offset = st.Received
		jobs.update(job, func(x *Job) { x.Done = offset })
	}
	r, err := c.Do("POST", "uploads/"+up.ID+"/complete", "", nil, nil)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	switch r.StatusCode {
	case 200:
		return nil
	case 422:
		return fmt.Errorf("Файл повредился при передаче. Попробуйте ещё раз.")
	}
	return apiError(r)
}

func (c *Client) doClose(method, path, q string, body io.Reader) (int, error) {
	r, err := c.Do(method, path, q, nil, body)
	if err != nil {
		return 0, err
	}
	r.Body.Close()
	return r.StatusCode, nil
}

// Download сохраняет файл по пути dest (сначала во временный файл).
func (c *Client) Download(jobs *Jobs, fileID, name string, size int64, version, dest string) *Job {
	job := jobs.add("download", name, size)
	go func() {
		err := func() error {
			q := ""
			if version != "" {
				q = "version=" + version
			}
			resp, err := c.Do("GET", "files/"+fileID+"/content", q, nil, nil)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				return apiError(resp)
			}
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return fmt.Errorf("Не удалось создать папку.")
			}
			tmp := dest + ".part"
			out, err := os.Create(tmp)
			if err != nil {
				return fmt.Errorf("Не удалось создать файл.")
			}
			defer os.Remove(tmp)
			buf := make([]byte, 256<<10)
			for {
				if jobs.cancelled(job) {
					out.Close()
					return nil
				}
				n, rerr := resp.Body.Read(buf)
				if n > 0 {
					if _, werr := out.Write(buf[:n]); werr != nil {
						out.Close()
						return fmt.Errorf("Не удалось записать файл.")
					}
					jobs.update(job, func(x *Job) { x.Done += int64(n) })
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					out.Close()
					return fmt.Errorf("Загрузка прервана.")
				}
			}
			if err := out.Close(); err != nil {
				return err
			}
			return os.Rename(tmp, dest)
		}()
		if err != nil {
			jobs.fail(job, err)
			return
		}
		jobs.update(job, func(x *Job) {
			if x.State == "running" {
				x.State = "done"
			}
		})
	}()
	return job
}

// mkdir создаёт папку в облаке (если такая уже есть, сервер возвращает её) и отдаёт её id.
func (c *Client) mkdir(parentID, name string) (string, error) {
	req := map[string]any{"name": name}
	if parentID != "" {
		req["parent_id"] = parentID
	}
	body, _ := json.Marshal(req)
	resp, err := c.Do("POST", "files/folders", "", http.Header{"Content-Type": {"application/json"}}, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", apiError(resp)
	}
	var out struct {
		File struct {
			ID string `json:"id"`
		} `json:"file"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.File.ID == "" {
		return "", fmt.Errorf("Облако вернуло неожиданный ответ.")
	}
	return out.File.ID, nil
}

// UploadTree: файл грузится как в Upload, папка создаётся в облаке и грузится вместе с содержимым.
func (c *Client) UploadTree(jobs *Jobs, path, parentID string) {
	st, err := os.Stat(path)
	if err != nil || !st.IsDir() {
		c.Upload(jobs, path, parentID)
		return
	}
	id, err := c.mkdir(parentID, filepath.Base(path))
	if err != nil {
		jobs.fail(jobs.add("upload", filepath.Base(path), 0), err)
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		jobs.fail(jobs.add("upload", filepath.Base(path), 0), fmt.Errorf("Не удалось прочитать папку."))
		return
	}
	for _, e := range entries {
		if e.Type()&os.ModeSymlink != 0 {
			continue // ссылки не выходят за пределы выбранной папки
		}
		c.UploadTree(jobs, filepath.Join(path, e.Name()), id)
	}
}
