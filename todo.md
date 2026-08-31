# WTM TODO

Bu dosya WTM'nin bir sonraki kararlı sürümünden önce tamamlanması gereken işleri öncelik sırasına
göre listeler.

> **Sürüm hedefi (2026-08-31 kararı):** Bu listedeki işler bittiğinde çıkılacak tag `v1.0.0` değil,
> **`v0.2.0`**'dır. Kapsam, öncelik sırası ve kabul kriterleri değişmiyor — sadece hangi sürüm
> numarasıyla yayınlanacağı değişiyor. Aşağıda geçen "stable" ifadelerini bu iş kümesinin adı olarak
> okuyun, semver sözü olarak değil: `0.2.0` hâlâ `0.x` olduğu için public API ve disk üzerindeki
> state kontratı açıkça kararsız kalır, ileriki bir increment'te breaking change major bump
> gerektirmez.

---

## P0 — Stable öncesi zorunlu

### [x] 1. `wtm remove` lifecycle'ını runtime-aware hale getir

Şu an `wtm remove` Git güvenlik kontrollerini yaptıktan sonra doğrudan worktree'yi siliyor. Dokümantasyonda vaat edilen runtime cleanup zinciri gerçek implementasyonda tamamlanmalı.

#### Yapılacaklar

- [x] Repository-level destructive operation lease al.
- [x] İlk Git safety analizini çalıştır.
- [x] Worktree'ye bağlı WTM managed process'lerini bul.
- [x] Çalışan process'leri graceful shutdown ile durdur.
- [x] Grace period sonrasında gerekirse process group cleanup uygula.
- [x] Process'lerin gerçekten durduğunu doğrula.
- [x] Worktree'ye ait ephemeral runtime resource'larını tespit et.
- [x] Ephemeral resource cleanup uygula.
- [x] Endpoint/port lease'lerini release et.
- [x] Git safety analizini tekrar çalıştır.
- [x] İlk ve son analiz arasında worktree identity'nin değişmediğini doğrula.
- [x] `git worktree remove` çalıştır.
- [x] State DB reconciliation çalıştır.
- [x] `worktree.removed` lifecycle event'ini emit et.
- [x] Operation lease'i bırak.
- [x] Her hata durumunda yarım kalan cleanup state'ini DB'de recoverable şekilde kaydet.

#### Beklenen akış

```text
REMOVE_REQUEST
    ↓
acquire repository operation lease
    ↓
analyze Git safety
    ↓
stop WTM-managed processes
    ↓
verify processes stopped
    ↓
cleanup/release ephemeral resources
    ↓
release endpoint leases
    ↓
re-analyze Git safety
    ↓
verify identity unchanged
    ↓
git worktree remove
    ↓
reconcile state
    ↓
emit worktree.removed
    ↓
release operation lease
```

#### Kabul kriterleri

- [x] Çalışan managed process varken worktree silinince orphan process kalmıyor.
- [x] Cleanup başarısızsa Git worktree silme işlemi başlamıyor.
- [x] Silme sırasında HEAD değişirse işlem bloklanıyor.
- [x] İşlem iki farklı terminalden aynı anda tetiklense race condition oluşmuyor.
- [x] Daemon crash sonrası yarım kalan cleanup recover edilebiliyor.

---

### [ ] 2. Cross-process repository operation locking ekle

Mevcut process-local `Map` mutex ayrı CLI process'leri veya daemon ile CLI arasında ortak değildir.

#### Yapılacaklar

- [x] SQLite tabanlı `repository_operation_leases` tablosu ekle.
- [x] Lease alanları:
  - `repository_id`
  - `operation`
  - `token`
  - `pid`
  - `process_start_time`
  - `acquired_at`
  - `expires_at`
- [x] Lease acquisition için transactional / `BEGIN IMMEDIATE` yaklaşımı kullan.
- [x] Expired/stale lease recovery ekle.
- [x] PID reuse riskine karşı process identity doğrulaması yap.
- [ ] `remove`, `gc`, destructive cleanup ve ileride `repair` gibi operasyonlarda aynı mekanizmayı kullan.
- [x] Lock conflict için stable JSON error code ekle.

#### Önerilen hata kodu

```text
WTM_OPERATION_CONFLICT
```

#### Kabul kriterleri

- [x] İki terminal aynı repository üzerinde destructive işlem başlatamıyor.
- [ ] CLI ve daemon aynı repository üzerinde çakışan destructive işlem yapamıyor.
- [x] Crash olmuş process'in lease'i sonsuza kadar kalmıyor.

---

### [x] 3. Remote freshness / explicit fetch desteği ekle

WTM şu anda local remote-tracking ref'lere göre `remote-persisted` kararı veriyor. Bu davranış korunmalı fakat kullanıcıya freshness açıkça gösterilmeli.

#### Yapılacaklar

- [x] `wtm analyze --refresh-remotes` ekle.
- [x] `wtm remove <selector> --refresh-remotes` ekle.
- [x] Alternatif/ek komut olarak `wtm remotes refresh` değerlendir.
- [x] Refresh işleminin network kullandığını açıkça belirt.
- [x] Default davranışta implicit `git fetch` yapma.
- [x] Analysis JSON'a remote knowledge metadata ekle.

#### Önerilen JSON

```json
{
  "remoteKnowledge": {
    "source": "local-refs",
    "refreshed": false,
    "refreshedAt": null,
    "confidence": "LOCAL_ONLY"
  }
}
```

Refresh sonrası:

```json
{
  "remoteKnowledge": {
    "source": "fetched-refs",
    "refreshed": true,
    "refreshedAt": "2026-08-31T00:00:00.000Z",
    "confidence": "REFRESHED"
  }
}
```

#### Kabul kriterleri

- [x] Silinmiş remote branch localde stale ref olarak duruyorsa `--refresh-remotes` bunu yakalıyor.
- [x] Default analiz network kullanmıyor.
- [x] JSON caller local-only ve refreshed safety bilgisini ayırt edebiliyor.

---

### [ ] 4. Performance release gate davranışını netleştir

Dokümantasyon ile workflow aynı şeyi söylemeli.

#### Karar

Aşağıdaki iki yaklaşımdan biri seçilmeli:

#### Tercih edilen: gerçek release gate

- [ ] ARM64 performance job release öncesi zorunlu olsun.
- [ ] x64 performance job release öncesi zorunlu olsun.
- [ ] Publish job performance sonuçlarına `needs` ile bağlı olsun.
- [ ] Stable release performance blocker varken yayınlanmasın.
- [ ] Prerelease için ayrı policy gerekiyorsa açıkça tanımla.

Önerilen akış:

```text
verify-arm64
verify-x64
performance-arm64
performance-x64
        ↓
      publish
```

#### Alternatif

- [ ] Performance testlerini "release gate" olarak tanımlayan dokümantasyonu değiştir.
- [ ] Bunları yalnızca monitoring/report olarak adlandır.

#### Kabul kriterleri

- [ ] Workflow ve docs aynı davranışı tarif ediyor.
- [ ] Performance blocker'ın release üzerindeki etkisi deterministic.

---

### [ ] 5. Stable macOS release için notarization ekle

Developer ID signing tek başına stable macOS dağıtımı için yeterli değil.

#### Yapılacaklar

- [ ] Apple notarization credentials/secrets ekle.
- [ ] `xcrun notarytool submit` pipeline'ı ekle.
- [ ] Notarization sonucu başarılı olmadan stable release'i yayınlama.
- [ ] Gerekiyorsa artifact paket formatını notarization'a göre düzenle.
- [ ] `spctl --assess` doğrulaması ekle.
- [ ] Gatekeeper verification testleri ekle.
- [ ] Release dokümantasyonunu güncelle.

#### Kabul kriterleri

- [ ] Stable artifact temiz macOS makinede Gatekeeper tarafından kabul ediliyor.
- [ ] Stable release notarization yoksa publish edilmiyor.

---

## P0 — `v0.1.0-rc.1` alan testi bulguları

Bu bölümdeki maddeler, yayınlanmış `v0.1.0-rc.1` arm64 arşivi indirilip izole bir `HOME` altında
uçtan uca çalıştırılarak bulundu. Aracın kendisi çalışıyor: `init`, `status`, `doctor`, `detect`,
`env`, `resolve`, `start`, `ps`, `stop`, `logs`, `analyze`, `remove` doğrulandı; iki worktree'ye
`3000` ve `3001` portları çakışmadan verildi; `remove` untracked dosya varken `GIT_UNTRACKED` ve
`GIT_HEAD_NOT_REMOTE_PERSISTED` ile reddetti. Aşağıdakiler o çalıştırmada çıkan kusurlar.

Numaralandırma dosyanın sonundan devam ediyor; mevcut madde numaraları kasıtlı olarak
değiştirilmedi.

**Bir sonraki tag'den önce:** 36 ve 37. Bunlar kod değil, paketleme ve dokümantasyon işi.

---

### [ ] 36. Tarayıcıdan indirilen binary Gatekeeper tarafından öldürülüyor

Executable yalnızca ad-hoc imzalı olduğu için `com.apple.quarantine` damgası taşıyan bir kopya
çalıştırılamıyor. Kernel süreci SIGKILL ediyor; kullanıcı hiçbir hata mesajı görmüyor.

#### Kanıt

```text
spctl -a -t execute wtm   ->  rejected (source=no usable signature)
./wtm --version           ->  exit 137, stdout ve stderr boş
```

README'de belgelenen `curl` yolu etkilenmiyor — `curl` ve `tar` quarantine xattr'ı yazmıyor. Sorun
yalnızca release sayfasındaki asset'e tarayıcıdan tıklayan kullanıcıda çıkıyor, ve README bu durumu
hiç anmıyor.

#### Yapılacaklar

- [ ] README install bölümüne tarayıcıyla indirme uyarısı ekle.
- [ ] Geçici çözümü belgele: `xattr -d com.apple.quarantine wtm`.
- [ ] Prerelease notlarına aynı uyarıyı koy.
- [ ] Sessiz SIGKILL yerine anlaşılır bir hata üretmenin mümkün olup olmadığını araştır.
- [ ] Kalıcı çözüm için 5. maddeye (Developer ID + notarization) bağla.

#### Kabul kriterleri

- [ ] Tarayıcıyla indiren kullanıcı README'de ne yapacağını buluyor.
- [ ] Notarization tamamlandığında bu geçici çözüm dokümandan kaldırılıyor.

---

### [ ] 37. README quick start ilk denemede çalışmıyor

Quick start (`README.md:126-135`) birebir uygulandığında hata veriyor:

```text
$ wtm resolve dev
[WTM_CONFIG_INVALID] Unknown task: dev
```

Görevler `package.json` script'lerinden otomatik türemiyor. Makefile'dan gelenler `make:dev` ve
`workspace:dev` isimli namespace'lerde. Quick start ise namespace'siz `dev` kullanıyor, üstelik
görev tanımlama adımı dosyada çok daha aşağıda anlatılıyor. WTM'yi ilk kez deneyen herkes bu duvara
çarpıyor.

#### Yapılacaklar

- [ ] Quick start'ı gerçekten çalışan bir görev adıyla düzelt (`make:dev`) veya görev tanımlama
      adımını quick start'ın içine al.
- [ ] `wtm resolve` ve `wtm start` hata mesajı bilinen görevleri listelesin.
- [ ] Hiç görev bulunmayan workspace'te mesaj görevin nasıl tanımlanacağını söylesin.
- [ ] README'deki her komutun temiz bir workspace'te çalıştığını doğrulayan test ekle (34. madde ile
      aynı parity testine bağlanabilir).

#### Kabul kriterleri

- [ ] README'yi baştan sona uygulayan kullanıcı hiçbir adımda hata almıyor.
- [ ] `Unknown task` hatası kullanıcıya mevcut görevleri gösteriyor.

---

### [ ] 38. npm kanalını ilk yayında doğrula

`worktree-runtime-manager` paketi registry'de henüz yok (`E404`). `NPM_TOKEN` secret'ı repoya
eklendi ve `nafrucom` olarak `package: write` yetkisiyle doğrulandı, publish adımı da artık
başarısızlığa toleranslı. Yine de ilk gerçek publish denenmedi.

#### Açık riskler

- Token `bypass_2fa: false`. Hesap yazma işlemlerinde OTP istiyorsa publish reddedilir; bu ayar
  yalnızca npm hesap ayarlarından görülebiliyor.
- Token `2026-11-29` tarihinde doluyor.
- npm 2FA-bypass token'larını kaldırıp Trusted Publishing'e (OIDC) yöneliyor.

#### Yapılacaklar

- [ ] Bir sonraki tag'den önce npm hesabının "require 2FA for writes" ayarını kontrol et.
- [ ] İlk publish sonrası paketin `@next` dist-tag'i ile yayınlandığını doğrula.
- [ ] `npm install --global worktree-runtime-manager@next` ile temiz kurulumu dene.
- [ ] Provenance attestation'ının registry'de göründüğünü doğrula.
- [ ] Token expiry için takvim hatırlatması bırak veya Trusted Publishing'e geç.

#### Kabul kriterleri

- [ ] README'de anlatılan npm kurulumu gerçekten çalışıyor.
- [ ] Publish başarısız olduğunda release yine ayakta kalıyor ve warning annotation'ı düşüyor.

---

### [ ] 39. Daemon socket hatası ham stack trace basıyor ve CI yollarını sızdırıyor

Derin bir `HOME` altında daemon başlatılamıyor:

```text
listen EINVAL
```

Sebep macOS'un `sun_path` sınırı: soket yolu 180 bayt, sınır 104. Bu doğru bir başarısızlık, ama
kullanıcıya diagnostic yerine ham bir Node stack trace olarak çıkıyor ve trace build makinesinin
yollarını içeriyor:

```text
/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs
```

#### Yapılacaklar

- [ ] Soket yolu uzunluğunu bind etmeden önce kontrol et.
- [ ] Sınır aşıldığında `WTM_` kodlu, ölçülen uzunluğu ve sınırı söyleyen bir hata üret.
- [ ] Çözüm önerisini mesaja koy (daha kısa bir `HOME` veya yapılandırılabilir runtime dizini).
- [ ] Kullanıcıya giden hiçbir hatanın build-time yol sızdırmadığını doğrulayan test ekle.
- [ ] `doctor`'a soket yolu uzunluğu kontrolü ekle.

#### Kabul kriterleri

- [ ] Uzun yolda çıkan hata tek satırlık, anlaşılır ve eyleme dönük.
- [ ] Hiçbir kullanıcı çıktısında `/Users/runner/...` görünmüyor.

---

### [ ] 40. `daemon status` sabit launchd label yüzünden başka `HOME`'un agent'ını raporluyor

`dev.wtm.daemon` sabit bir label. Farklı bir `HOME` ile çalıştırıldığında `wtm daemon status`
başka bir oturumun LaunchAgent'ını kendi agent'ıymış gibi gösteriyor:

```text
state: loaded
runState: running
plistPath: <bu oturumun HOME'u>
reachable: false
```

Yani launchd durumu bir agent'tan, erişilebilirlik başka bir agent'tan geliyor. Çıktı kendi içinde
çelişiyor.

#### Yapılacaklar

- [ ] launchd label'ını `HOME`/workspace kökünden türetilen bir ayrımla üret.
- [ ] Ya da `daemon status` yüklü agent'ın program yolunu kendi yoluyla karşılaştırıp eşleşmiyorsa
      açıkça söylesin.
- [ ] `plistPath`'in raporlanan `state` ile aynı agent'a ait olduğunu doğrula.
- [ ] Migration: eski sabit label'lı agent'ları tanı ve devral.

#### Kabul kriterleri

- [ ] İki farklı `HOME`'daki daemon birbirinin durumunu raporlamıyor.
- [ ] `state`, `runState` ve `reachable` her zaman aynı agent'ı anlatıyor.

---

### [ ] 41. `init` sonrası oluşturulan worktree reconcile olana kadar görünmez

Daemon erişilebilir değilken `git worktree add` ile açılan bir worktree WTM tarafından
tanınmıyor:

```text
repositoryId: null
wtm env      -> [GIT_REPOSITORY_DEGRADED]
wtm doctor   -> "not inside a worktree WTM has registered"
```

`wtm init --yes` tekrar çalıştırılınca her şey düzeliyor. Yani veri kaybı yok, eksik olan
reconciliation tetiklemesi ve kullanıcıya ne yapacağını söyleyen mesaj.

#### Yapılacaklar

- [ ] Daemon erişilemezken kayıtsız bir worktree'de çalışan komutlar bunu ayrı bir tanı olarak
      raporlasın.
- [ ] Hata mesajı `wtm init` veya daemon başlatmayı önersin.
- [ ] Daemon yokken CLI'ın tek seferlik reconciliation yapıp yapamayacağını değerlendir.
- [ ] Daemon ayağa kalktığında bekleyen worktree'leri otomatik reconcile et.
- [ ] `doctor` "daemon erişilemez" ile "worktree kayıtlı değil" durumlarını ayırsın.

#### Kabul kriterleri

- [ ] Kullanıcı yeni worktree'sinin neden görünmediğini çıktıdan anlıyor.
- [ ] Daemon geri geldiğinde manuel `init` gerekmiyor.

---

### [ ] 42. Idle RSS bütçe hedefinin üzerinde

Idle daemon ölçümü 60 MiB hedefinin üzerinde, 80 MiB investigation eşiğinin altında:

```text
73.9 MiB
63.7 MiB
```

Test bunu `warning` olarak raporluyor, `blocker` değil — yani release'i durdurmuyor ama hedef
tutmuyor.

#### Yapılacaklar

- [ ] RSS'i neyin tuttuğunu ölç (SQLite, structural watcher, embedded runtime).
- [ ] Hedefi tutturmak ile hedefi gerçekçi bir değere çekmek arasında karar ver.
- [ ] Karar hedefi değiştirmekse `docs` ve `idle-daemon.scenario.ts` içindeki 60 MiB'ı birlikte
      güncelle.
- [ ] Ölçümü her iki mimaride de tekrarla.

#### Kabul kriterleri

- [ ] Yayınlanan hedef ile ölçülen değer aynı hikâyeyi anlatıyor.
- [ ] Stable release'te RSS `pass` veriyor.

---

## P1 — V1 deneyimini tamamlayacak işler

### [ ] 6. `wtm create` ekle

WTM worktree lifecycle'ın sonunu yönetiyor fakat başlangıcını doğrudan yönetmiyor.

#### Minimum CLI

```bash
wtm create feat/auth
wtm create feat/auth --from main
wtm create feat/auth --json
```

#### Multi-repo

```bash
wtm create feat/auth --repos web,api,worker
```

#### Yapılacaklar

- [ ] Branch var/yok kontrolü.
- [ ] Existing worktree conflict kontrolü.
- [ ] Target path strategy.
- [ ] Multi-repo branch alignment.
- [ ] Worktree oluşturulduktan sonra reconcile.
- [ ] Eager/lazy resource prepare policy ile uyum.
- [ ] `worktree.created` event entegrasyonu.
- [ ] `--json` stable output.
- [ ] Partial multi-repo creation rollback/recovery.

#### Kabul kriterleri

- [ ] Tek repo create deterministic.
- [ ] Multi-repo create aynı feature identity altında çalışıyor.
- [ ] Yarım kalan creation güvenli biçimde recover ediliyor.

---

### [ ] 7. Gerçek cleanup candidate ranking ekle

`wtm analyze --cleanup-candidates` yalnızca linked worktree filtresi olmamalı.

#### Ranking girdileri

- [ ] deletion readiness
- [ ] age
- [ ] merged/reachable state
- [ ] remote persistence
- [ ] reclaimable disk size
- [ ] last WTM activity
- [ ] running process var/yok
- [ ] prunable state

#### Önerilen sonuç

```json
{
  "rank": 1,
  "score": 92,
  "reason": [
    "SAFE",
    "merged",
    "inactive-14-days",
    "reclaimable-2.4GB"
  ]
}
```

#### Kabul kriterleri

- [ ] Çıktı deterministic.
- [ ] Ranking hiçbir zaman otomatik delete yapmıyor.
- [ ] Human ve JSON output aynı candidate sırasını kullanıyor.

---

### [ ] 8. Allowed remote refs configuration ekle

Core desteği kullanıcı config katmanına bağlanmalı.

#### Önerilen config

```toml
[git]
allowed_remote_refs = [
  "refs/remotes/origin/*",
  "refs/remotes/upstream/*"
]
```

#### Yapılacaklar

- [ ] Schema ekle.
- [ ] Config validation ekle.
- [ ] Provenance desteği ekle.
- [ ] `analyze` ve `remove` resolved config'i kullansın.
- [ ] Invalid wildcard pattern testleri ekle.
- [ ] `wtm explain` içinde göster.

---

### [ ] 9. WTM'yi gerçek cross-platform yap: macOS + Linux + Windows

WTM'nin ürün hedefi yalnızca macOS olmamalı. Core ve protocol katmanları platform-independent kalmalı; işletim sistemine bağlı davranışlar tek bir platform abstraction arkasına alınmalı.

#### Destek hedefi

```text
macOS   ✅ first-class
Linux   ✅ first-class
Windows ✅ first-class
```

#### Ayırılacak platform katmanları

```text
daemon/service lifecycle
filesystem watcher
process inspection
process tree/group signalling
process identity
user data/config/cache paths
socket / IPC transport
service manager
permission model
binary install paths
shell integration
path normalization
symlink/junction handling
```

#### Hedef mimari

```text
PlatformRuntime
├── MacOSPlatformRuntime
├── LinuxPlatformRuntime
└── WindowsPlatformRuntime
```

Core paketleri işletim sistemini doğrudan bilmemeli:

```text
protocol
core
config
git analysis
state
resource graph
endpoint allocation
task resolution
```

platform bağımsız kalmalı.

---

#### macOS backend

```text
launchd / LaunchAgent
Unix domain socket
POSIX process groups
fs.watch / FSEvents
~/Library/Application Support/WTM
~/Library/Logs/WTM
```

---

#### Linux backend

Önerilen yaklaşım:

```text
systemd --user
Unix domain socket
POSIX process groups
fs.watch / inotify-backed Node watcher
XDG_CONFIG_HOME
XDG_STATE_HOME
XDG_CACHE_HOME
XDG_RUNTIME_DIR
```

##### Linux yapılacaklar

- [ ] `systemd --user` service installer/uninstaller.
- [ ] `systemctl --user` lifecycle.
- [ ] XDG directory resolution.
- [ ] Unix socket path policy.
- [ ] POSIX process group supervision.
- [ ] Linux process start-time / identity verification.
- [ ] inotify/fs.watch davranış testleri.
- [ ] Linux permission / symlink semantics testleri.
- [ ] ARM64 + x64 binary build pipeline.

---

#### Windows backend

Windows desteği POSIX process-group mantığını taklit etmeye çalışmamalı; native Windows semantics kullanılmalı.

Önerilen yaklaşım:

```text
named pipes
Job Objects
Windows process creation time
ReadDirectoryChangesW / Node watcher
LocalAppData / AppData paths
Scheduled Task veya per-user background process/service strategy
NTFS junction/symlink semantics
```

##### Windows yapılacaklar

- [ ] IPC için Unix socket yerine Named Pipe backend.
- [ ] Process supervision için Windows Job Objects veya güvenli eşdeğer.
- [ ] Child process tree cleanup.
- [ ] PID reuse kontrolü için process creation time.
- [ ] Windows path canonicalization.
- [ ] Drive letter / UNC path desteği.
- [ ] NTFS junction, symlink ve reparse point güvenliği.
- [ ] `LOCALAPPDATA` / `APPDATA` tabanlı WTM paths.
- [ ] Per-user daemon lifecycle stratejisi.
- [ ] PowerShell uyumlu install/uninstall.
- [ ] PowerShell completion.
- [ ] Git Bash kullanımının ayrıca test edilmesi.
- [ ] Windows ARM64 ileride; ilk hedef Windows x64.
- [ ] Native Windows CI.

#### Windows daemon lifecycle kararı

V1 cross-platform aşamasında aşağıdaki seçeneklerden biri seçilmeli:

```text
A. Windows Scheduled Task
B. Login ile başlayan per-user background process
C. Native per-user Windows Service wrapper
```

İlk tercih mümkün olduğunca yönetici yetkisi istemeyen bir çözüm olmalı.

#### IPC abstraction

```ts
interface IpcTransport {
  listen(handler): Promise<void>
  connect(): Promise<IpcClient>
  close(): Promise<void>
}
```

Implementasyonlar:

```text
UnixSocketTransport     -> macOS/Linux
NamedPipeTransport      -> Windows
```

#### Process abstraction

```ts
interface ProcessPlatform {
  inspectProcess(...)
  inspectProcessTree(...)
  terminateProcessTree(...)
  getProcessIdentity(...)
}
```

macOS/Linux:

```text
PID + PGID + process start time
```

Windows:

```text
PID + creation time + Job Object identity
```

#### Path abstraction

Hard-coded:

```text
~/Library/Application Support/WTM
```

gibi yollar core içinde bulunmamalı.

Örnek:

```ts
interface PlatformPaths {
  configDir: string
  stateDir: string
  cacheDir: string
  logsDir: string
  runtimeDir: string
}
```

#### Binary/release hedefleri

```text
wtm-darwin-arm64
wtm-darwin-x64
wtm-linux-arm64
wtm-linux-x64
wtm-windows-x64.exe
```

İleride:

```text
wtm-windows-arm64.exe
```

#### Kabul kriterleri

- [ ] Core package platform-independent.
- [ ] Platform-specific import'lar platform package dışında minimum.
- [ ] macOS regression yok.
- [ ] Linux x64 CI green.
- [ ] Linux arm64 build doğrulanıyor.
- [ ] Windows x64 CI green.
- [ ] Aynı `wtm.toml` mümkün olduğunca üç OS'ta da çalışıyor.
- [ ] JSON contract platformlar arasında aynı kalıyor.
- [ ] CLI command names platforma göre değişmiyor.
- [ ] Platform-specific farklar `wtm doctor` ile açıkça raporlanıyor.

---

### [ ] 10. Managed task readiness / healthcheck ekle

`wtm start dev` process doğduğu için başarılı sayılmamalı; kullanıcı isterse servisin hazır olmasını bekleyebilmeli.

#### CLI

```bash
wtm start dev --wait
wtm start dev --wait --timeout 30s
```

#### Config

```toml
[tasks.dev.healthcheck]
type = "http"
url = "http://localhost:{port.web}/health"
timeout = "30s"
interval = "500ms"
```

Alternatif tipler:

```text
http
tcp
process
command
```

#### Kabul kriterleri

- [ ] Process spawn olup servis ayağa kalkmazsa start sonucu bunu gösterebiliyor.
- [ ] JSON output readiness durumunu içeriyor.
- [ ] Agent'lar `wtm start --wait` sonrası ortamın hazır olduğunu güvenle varsayabiliyor.

---

### [ ] 11. Shell completion ekle

Destek:

- [ ] zsh
- [ ] bash
- [ ] fish

Örnek:

```bash
wtm completion zsh
wtm completion bash
wtm completion fish
```

Completion kaynakları:

- commands
- task names
- worktree selectors
- repo selectors

---

## P2 — Ürünü belirgin biçimde farklılaştıracak işler

### [ ] 12. Local reverse proxy / stable feature domains

Port numaralarını kullanıcıdan tamamen gizlemek için feature bazlı local domain routing ekle.

Örnek:

```text
https://web.auth.wtm.localhost
https://api.auth.wtm.localhost

https://web.billing.wtm.localhost
https://api.billing.wtm.localhost
```

#### Yapılacaklar

- [ ] Local reverse proxy backend.
- [ ] Feature/repo/endpoint domain naming.
- [ ] Stable hostname allocation.
- [ ] HTTPS gerekiyorsa local certificate strategy.
- [ ] CORS origins ile otomatik entegrasyon.
- [ ] Port allocation ile backward compatibility.

---

### [ ] 13. GitHub / PR awareness

Opsiyonel entegrasyon.

Örnekler:

```bash
wtm status
```

çıktısında:

```text
PR #184
open
checks passing
mergeable
```

#### Kurallar

- [ ] Core için GitHub zorunlu dependency olmasın.
- [ ] Network kullanımı explicit olsun.
- [ ] GitHub CLI (`gh`) veya adapter üzerinden uygulanabilir.
- [ ] GitLab/Bitbucket desteğini engellemeyecek interface kullan.

---

### [ ] 14. Automatic idle runtime suspension

Uzun süre kullanılmayan managed task'lar isteğe bağlı durdurulabilsin.

Config:

```toml
[runtime.idle]
enabled = true
timeout = "30m"
```

#### Güvenlik

- [ ] Default kapalı.
- [ ] Interactive/debug task'larda yanlışlıkla stop etmemeli.
- [ ] Resume strategy net olmalı.
- [ ] Agent activity ile human activity ayrımı zorunlu değil ama ileride desteklenebilir.

---

### [ ] 15. TUI / Menu Bar

CLI olgunlaştıktan sonra.

Gösterebilecekleri:

```text
workspace
worktrees
running tasks
ports
health
disk usage
cleanup candidates
logs
```

Bu özellik core logic taşımamalı; yalnızca mevcut stable protocol üzerinden çalışmalı.

---

## P2 — Analysis ve UX iyileştirmeleri

### [ ] 16. Ignored dosyaları `untracked` grubundan ayır

Şu an ignored content safety açısından doğru şekilde blocker ancak JSON semantics daha açık olabilir.

#### Önerilen yapı

```json
{
  "counts": {
    "staged": 0,
    "unstaged": 0,
    "untracked": 2,
    "ignored": 3,
    "unmerged": 0
  }
}
```

Önerilen error code:

```text
GIT_IGNORED_CONTENT
```

---

### [ ] 17. Symlink removal policy configurable olsun

Default davranış mevcut güvenli davranışta kalabilir.

Öneri:

```toml
[safety]
untracked_symlinks = "ignore"
```

Destek:

```text
ignore
review
block
```

---

### [ ] 18. Port probing'i batch hale getir

Şu an her candidate için child process spawn maliyeti var.

#### Hedef

Tek helper/process:

```json
{
  "candidates": [
    {"host":"127.0.0.1","port":3000,"protocol":"tcp"},
    {"host":"127.0.0.1","port":3001,"protocol":"tcp"}
  ]
}
```

ve tek cevap:

```json
{
  "available": [3001]
}
```

#### Not

Rust yalnızca profiler bunun gerçek bottleneck olduğunu gösterirse düşünülmeli.

---

## P3 — Sonraki dönem

### [ ] 19. Resource budgets

Opsiyonel:

```toml
[runtime.budgets]
max_processes = 20
max_memory = "4GiB"
max_disk = "20GiB"
```

---

### [ ] 20. Workspace presets / templates

Örnek preset'ler:

```text
nextjs
nextjs-hono
bun-monorepo
docker-compose
python-uv
rust
go
```

Bunlar detection'ın yerine geçmemeli; yalnızca bootstrap kolaylığı sağlamalı.

---

### [ ] 21. Plugin / adapter ecosystem geliştirme

- [ ] Adapter SDK package.
- [ ] Adapter authoring guide.
- [ ] Adapter contract versioning.
- [ ] Adapter test harness.
- [ ] Trust UX iyileştirmesi.
- [ ] Community adapter registry ancak ihtiyaç oluşursa.

---

# GitHub repository / public project presentation

### [ ] 22. GitHub ana sayfasını cross-platform ürün konumlandırmasına göre güncelle

Repo artık yalnızca macOS aracı olarak sunulmamalı. README, GitHub About alanı, topics, badges, release bölümü ve örnekler macOS + Linux + Windows hedefini doğru anlatmalı.

#### Repo description

Mevcut macOS-only açıklama yerine daha genel bir açıklama kullanılmalı.

Öneri:

```text
Local-first runtime and safety manager for Git worktrees and coding agents — isolated tasks, environments, ports, processes, and safe cleanup across macOS, Linux, and Windows.
```

Daha kısa alternatif:

```text
Cross-platform runtime and safety manager for parallel Git worktrees and coding agents.
```

#### GitHub About / Topics

Eklenmesi önerilen topics:

```text
git
git-worktree
worktree
worktrees
developer-tools
cli
devtools
ai-agents
coding-agents
local-development
process-manager
port-management
monorepo
typescript
bun
nodejs
macos
linux
windows
cross-platform
```

- [ ] GitHub repository description güncelle.
- [ ] Topics güncelle.
- [ ] Website/homepage alanını kontrol et.
- [ ] Release/installation linklerini görünür hale getir.

---

### [ ] 23. README hero bölümünü yeniden yaz

README ilk ekranı ürünün gerçek değerini anlatmalı.

Önerilen ana mesaj:

```text
# WTM — Worktree Runtime Manager

Run every Git worktree like its own development environment.

WTM gives every branch/worktree isolated tasks, environment, ports and managed
processes, then protects you from deleting work that has not been safely persisted.

Built for developers and coding agents working in parallel on macOS, Linux and Windows.
```

#### README ilk bölümünde mutlaka göster

- [ ] Cross-platform badge.
- [ ] macOS badge.
- [ ] Linux badge.
- [ ] Windows badge.
- [ ] Latest release badge.
- [ ] CI badge.
- [ ] npm version badge.
- [ ] License badge.
- [ ] JSON/Agent-friendly badge gerekiyorsa korunabilir.

#### Platform durumu tablosu

```markdown
| Platform | CLI | Daemon | Process supervision | Release binary |
| --- | --- | --- | --- | --- |
| macOS | ✅ | ✅ launchd | ✅ | ✅ arm64 / x64 |
| Linux | ✅ | ✅ systemd --user | ✅ | ✅ arm64 / x64 |
| Windows | ✅ | ✅ | ✅ | ✅ x64 |
```

Platform henüz geliştirme aşamasındaysa yanıltıcı ✅ kullanılmamalı:

```text
✅ Supported
🚧 In progress
🗓 Planned
```

README her zaman gerçek durumu göstermeli.

---

### [ ] 24. README install bölümünü platform bazlı düzenle

Önerilen yapı:

```text
Install
├── macOS
│   ├── Homebrew
│   ├── standalone binary
│   └── npm
├── Linux
│   ├── install script / standalone binary
│   ├── package manager ileride
│   └── npm
└── Windows
    ├── PowerShell install
    ├── standalone .exe
    ├── Scoop/WinGet ileride
    └── npm
```

#### macOS

```bash
brew install 0furkancolak/wtm/wtm
```

ve standalone tarball.

#### Linux

Örnek hedef:

```bash
curl -fsSL https://.../install.sh | sh
```

veya doğrudan:

```text
wtm-linux-x64.tar.gz
wtm-linux-arm64.tar.gz
```

#### Windows

PowerShell örneği:

```powershell
irm https://.../install.ps1 | iex
```

ve standalone:

```text
wtm-windows-x64.zip
```

- [ ] Install scriptlerin checksum doğrulaması yapması.
- [ ] Architecture autodetection.
- [ ] Existing install upgrade desteği.
- [ ] Uninstall dokümantasyonu.

---

### [ ] 25. Requirements bölümünü macOS-only olmaktan çıkar

README'deki:

```text
macOS required
```

gibi ifadeler platform capability tablosuna çevrilmeli.

Öneri:

```text
Requirements

Standalone binaries:
- Git 2.x+
- supported operating system

npm installation:
- Node.js 24+

Development from source:
- Bun 1.3+
- Node.js 24+
```

Daemon requirements platform bazlı açıklanmalı.

---

### [ ] 26. Architecture docs'a Platform Layer bölümü ekle

`docs/02-architecture.md` güncellenmeli.

Eski:

```text
macOS
 ↓
launchd
 ↓
wtmd
```

yerine:

```text
                    Platform Runtime
          ┌──────────────┼──────────────┐
          │              │              │
        macOS          Linux         Windows
       launchd        systemd        user daemon
          │              │              │
    Unix socket      Unix socket     Named Pipe
          └──────────────┼──────────────┘
                         │
                        wtmd
                         │
                       Core
```

- [ ] Platform interface'leri dokümante et.
- [ ] Process model farklarını dokümante et.
- [ ] IPC farklarını dokümante et.
- [ ] Filesystem/path farklarını dokümante et.

---

### [ ] 27. Roadmap'i cross-platform olarak yeniden düzenle

`docs/15-roadmap.md` içindeki:

```text
Linux support — deferred
```

ifadesi kaldırılmalı.

Yeni yaklaşım:

```text
Phase 8 — Cross-platform runtime
  Linux
  Windows

veya

V1.x:
  Linux
  Windows
```

Eğer hedef stable `v1.0` öncesi üç platform ise roadmap buna göre tamamen yeniden sıralanmalı.

---

### [ ] 28. Package metadata'yı güncelle

`package.json` şu an:

```json
"os": ["darwin"]
```

ile macOS'a kilitli.

Cross-platform hazır olduğunda:

- [ ] `os` restriction kaldır veya üç OS'u tanımla.
- [ ] keywords içine `linux`, `windows`, `cross-platform` ekle.
- [ ] description güncelle.
- [ ] npm README platform tablosuyla eşleşsin.
- [ ] Node engine requirement tekrar değerlendir.

Not: Windows/Linux desteği tamamlanmadan `os` restriction kaldırılmamalı; yarım destek npm kullanıcılarına kırık paket vermemeli.

---

### [ ] 29. Release workflow'u çoklu OS matrix'e geçir

Hedef:

```text
build/
├── macos-arm64
├── macos-x64
├── linux-arm64
├── linux-x64
└── windows-x64
```

#### CI matrix

```yaml
include:
  - os: macos
    arch: arm64
  - os: macos
    arch: x64
  - os: linux
    arch: x64
  - os: linux
    arch: arm64
  - os: windows
    arch: x64
```

#### Release assets

```text
wtm-darwin-arm64.tar.gz
wtm-darwin-x64.tar.gz
wtm-linux-arm64.tar.gz
wtm-linux-x64.tar.gz
wtm-windows-x64.zip
SHA256SUMS
```

- [ ] Artifact names stable contract olsun.
- [ ] Her platform smoke tested.
- [ ] Checksums tüm platformları kapsasın.
- [ ] Build provenance tüm artifact'lar için üret.
- [ ] Release gate tüm required platformları görmeden publish etmesin.

---

### [ ] 30. Platform-specific package manager dağıtımları

Stable sonrası hedef:

#### macOS

- [ ] Homebrew

#### Linux

Öncelik sırası:

- [ ] standalone binary
- [ ] Homebrew/Linuxbrew
- [ ] `.deb` / apt repository ancak talep oluşursa
- [ ] `.rpm` ancak talep oluşursa

#### Windows

Öncelik sırası:

- [ ] standalone zip/exe
- [ ] Scoop
- [ ] WinGet
- [ ] Chocolatey ancak talep oluşursa

npm tüm platformlarda ortak kanal olarak kalabilir.

---

### [ ] 31. GitHub Actions badge ve platform CI görünürlüğü

README'de platformların gerçekten test edildiğini görünür yap.

Örneğin:

```text
CI macOS
CI Linux
CI Windows
```

Ayrı workflow kullanılıyorsa ayrı badge; tek matrix workflow kullanılıyorsa tek CI badge yeterli.

Ayrıca:

- [ ] `CONTRIBUTING.md` platform test komutlarını içersin.
- [ ] `SECURITY.md` platform-specific security concerns içersin.
- [ ] `SUPPORT.md` desteklenen OS/version tablosu içersin.

---

### [ ] 32. Examples üç platformda portable olmalı

Mevcut örnekler Unix shell'e veya macOS path'lerine gereksiz bağımlı olmamalı.

Kontrol:

- [ ] `examples/minimal`
- [ ] `examples/multi-repo`
- [ ] `examples/bun-monorepo`
- [ ] `examples/docker-compose`
- [ ] `examples/polyglot`

Kurallar:

- mümkün olduğunca argv array;
- shell gerekli değilse shell script kullanma;
- `/tmp`, `/Users/...`, `$HOME/...` hard-code etme;
- Windows path testleri ekle;
- shell-required task'larda platform-specific örnek göster.

---

### [ ] 33. Agent Skill cross-platform hale getir

`skills/wtm/SKILL.md` yalnızca POSIX/macOS varsayımlarına dayanmamalı.

- [ ] Platform detection rehberi.
- [ ] Windows'ta PowerShell/Git Bash farkları.
- [ ] Manuel `kill`, `pkill`, `lsof` gibi platform-specific workaround'ları önermemesi.
- [ ] Her platformda WTM'nin kendi `status`, `ports`, `ps`, `stop`, `doctor` komutlarını tercih etmesi.
- [ ] Skill içindeki install/daemon örneklerini platform-aware yap.

---


# Documentation / consistency checklist

### [ ] 34. Kod ve docs parity testi ekle

Dokümantasyonda geçen komutların gerçekten CLI'da mevcut olduğunu test et.

Kontrol edilecekler:

```text
README command reference
docs/04-cli-reference.md
skills/wtm/SKILL.md
examples/
```

### [ ] 35. Documented lifecycle parity testleri

Özellikle:

```text
remove lifecycle
cleanup candidates
performance gate
resource lifecycle
events
```

dokümanda anlatıldığı gibi çalışıyor mu test edilmeli.

---

# Testing checklist

### [ ] Removal

- [x] running managed process
- [x] cleanup failure
- [x] port release
- [x] resource release
- [x] concurrent CLI remove
- [ ] CLI + daemon conflict
- [x] crash during cleanup
- [x] HEAD changes between checks
- [ ] branch changes between checks

### [ ] Remote safety

- [x] stale local remote ref
- [x] deleted remote branch after refresh
- [x] multiple remotes
- [ ] allowed refs config
- [x] detached HEAD
- [x] no upstream
- [x] commit persisted in another remote branch

### [ ] Create

- [ ] existing branch
- [ ] new branch
- [ ] conflicting worktree
- [ ] partial multi-repo failure
- [ ] daemon running
- [ ] daemon stopped
- [ ] eager prepare
- [ ] lazy prepare

### [ ] Runtime

- [ ] daemon restart
- [ ] PID reuse
- [ ] process group child spawning
- [ ] start conflict
- [ ] stop conflict
- [ ] healthcheck timeout
- [ ] log rotation

### [ ] Platform

- [ ] macOS arm64
- [ ] macOS x64
- [ ] Linux x64
- [ ] Linux arm64
- [ ] Windows x64
- [ ] Windows path/drive-letter tests
- [ ] Windows Named Pipe IPC tests
- [ ] Windows Job Object/process-tree cleanup tests
- [ ] Cross-platform config fixture tests
- [ ] Cross-platform JSON contract parity

### [ ] Distribution / install

- [ ] tarayıcıyla indirilmiş (quarantine damgalı) macOS binary
- [ ] `curl` + `tar` ile kurulum
- [ ] npm `@next` global kurulum
- [ ] README quick start'ın temiz bir workspace'te baştan sona çalışması
- [ ] `sun_path` sınırını aşan uzun `HOME`
- [ ] farklı `HOME`'larda aynı anda iki daemon
- [ ] `init` sonrası oluşturulan worktree

---

# Release checklist — Stable v1.0

Stable `v1.0.0` tag'i aşağıdakiler tamamlanmadan çıkarılmamalı:

- [ ] P0 maddelerinin tamamı bitmiş.
- [x] `wtm remove` runtime-aware.
- [x] Cross-process destructive operation lease mevcut.
- [x] Remote freshness semantics net.
- [ ] Performance workflow/docs parity sağlanmış.
- [ ] Stable macOS binary Developer ID signed.
- [ ] Stable macOS binary notarized.
- [ ] macOS ARM64 CI green.
- [ ] macOS x64 CI green.
- [ ] Linux x64 CI green.
- [ ] Linux ARM64 build/smoke green.
- [ ] Windows x64 CI green.
- [ ] E2E green.
- [ ] Binary smoke tests green.
- [ ] Package verification green.
- [ ] JSON contract compatibility testleri green.
- [ ] Migration/upgrade testleri green.
- [ ] README ile CLI parity doğrulanmış.
- [ ] Agent Skill ile CLI parity doğrulanmış.
- [ ] Changelog hazırlanmış.
- [ ] Homebrew stable install doğrulanmış.
- [ ] npm stable `latest` dist-tag doğrulanmış.
- [ ] Tarayıcıyla indirilen macOS binary Gatekeeper tarafından çalıştırılabiliyor.
- [ ] README quick start temiz bir workspace'te hatasız tamamlanıyor.
- [ ] Idle RSS ölçümü `pass` veriyor.

---

# Önerilen geliştirme sırası

```text
1. repository operation leases
2. runtime-aware remove
3. remote refresh/freshness
4. platform abstraction
5. Linux backend
6. Windows backend
7. multi-platform CI/release pipeline
8. GitHub/README cross-platform refresh
9. performance release gate consistency
10. macOS notarization
11. wtm create
12. cleanup candidate ranking
13. allowed remote refs config
14. readiness/healthcheck
15. local domains
16. GitHub/PR awareness
17. idle runtime
18. TUI/menu bar
```

Bu sıra özellikle destructive safety ve stable release risklerini önce kapatacak şekilde hazırlanmıştır.
