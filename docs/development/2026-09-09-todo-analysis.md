# WTM: TODO analizi ve ilk geliştirme dilimi

Tarih: 2026-09-09. İncelenen başlangıç commit'i: `2fbdd02b5abec90a79dc661dc9f069726cea9831`.
Sürüm hedefi: `v0.2.0`; mevcut paket sürümü `0.1.0-rc.1`.

**Devam oturumu güncellemesi:** `816fb11` ve `7962428` aynı çalışma kopyasında içerikleriyle
doğrulandı; eksik devir yoktu, başlangıç çalışma ağacı temizdi. Aşağıdaki ilk analiz ve
135 testlik sonuç önceki dilimin kaydıdır. Madde 45'in uygulaması ve bu oturumun bağımsız
doğrulama sonuçları dosyanın sonundaki **Ortak kuyruk uygulaması** bölümündedir.

## Sonuç

WTM'nin temel güvenlik ve runtime yapısı mevcut. Yeni bir mimari kurmak yerine, açık maddeleri
mevcut kod ve testlerle eşleştirerek küçük dilimler hâlinde ilerlemek uygun. `todo.md` başlıklarının
açık olması, altındaki işin hiç yapılmadığı anlamına gelmiyor; bazıları tek bir eksik kabul
kriteri nedeniyle açık. Dokümandaki eski tasarım dosyaları da uygulama tamamlandığı hâlde
"planned, not started" diyebiliyor. Güncel durum için kod, test ve ana TODO birlikte okunmalı.

## Mimari ve mevcut durum

| Alan | Kodda bulunan yapı | Sonraki iş açısından anlamı |
| --- | --- | --- |
| Protocol | Zod hata/IPC/JSON sözleşmeleri | Yeni hata kodu yalnızca core'a eklenemez; protocol, CLI exit kodu ve doküman birlikte değişmeli. |
| Core | Config, Git analizi, SQLite state, resource cleanup, operation lease | Güvenlik ve sahiplik kuralları bu katmanda kalmalı. |
| Platform | Process, IPC, path, trust ve service arayüzleri | Linux/macOS/Windows doğrulaması salt fixture testleriyle tamamlanmış sayılmamalı. |
| Daemon | Reconcile, task çözümleme, process supervision, lifecycle events | Readiness ve çok depolu create, mevcut daemon davranışına bağlanmalı. |
| CLI | Commander girişleri, yerel/daemon composition, JSON/human çıktı | `main.ts` büyük; yeni iş mantığı buraya yığılmamalı. Bu dilimde geniş bir refactor yapılmadı. |
| Testkit | Geçici Git depoları, yerel bare remote, izole Node senaryoları | Silme testlerinde gerçek Git ve geçici dosyalar kullanılabiliyor. |

## Önceliklerin kodla karşılaştırılması

| TODO | Doğrulanan durum | Kalan bağımlılık / yapılacak iş |
| --- | --- | --- |
| 1, 2: removal ve locking | Runtime cleanup zinciri, SQLite lease ve repository genelinde cross-operation conflict mevcut. | Gelecekteki `repair` komutu henüz yok; bunun için mevcut kilidi baştan yazmak gerekmiyor. Native process/lease testleri ayrıca geçmeli. |
| 3, 8: remote safety | Explicit fetch ve allowed remote refs config mevcut. | Yerel ref bilgisi ile fetched bilgi ayrımı korunmalı. |
| 4: performance gate | Release workflow ve verifier içinde gerçek gate mevcut. | Gate kodunun varlığı, gerçek platform ölçümlerinin başarılı olduğu anlamına gelmez. |
| 5, 36: macOS dağıtımı | Notarization submission ve publish gate kodu mevcut. | Apple credential kurulumu ve quarantine taşıyan artifact'ın temiz macOS üzerinde denenmesi gerekiyor. |
| 38: npm yayın kanalı | Publish akışı tanımlı. | Gerçek registry publish, dist-tag, provenance ve temiz kurulum kabul kriterleri açık. Bu dilimde yayın yapılmadı. |
| 6: create | Tek depoda yeni/var olan branch, `--from`, çakışma kontrolleri, local reconcile mevcut. CLI create testleri başarılı. | Çok depolu feature identity, kalıcı creation journal, lock sırası ve partial failure recovery tasarlanmalı. |
| 7: cleanup ranking | Güvenlik, çalışan process, persistence, aktivite, commit yaşı ve prunable bilgisi sıralamaya giriyor. | Reclaimable disk ölçümü yok; recursive tarama bütçesi ve hardlink/symlink/shared storage semantiği belirlenmeden sayı eklenmemeli. |
| 9: platformlar | Üç platform için katmanlar ve CI matrix girdileri var. | TODO'nun Windows native doğrulama ve Linux ARM64 açık kriterleri korunmalı; matrix satırı tek başına destek kanıtı değil. |
| 10: readiness | `start` ve supervisor mevcut; task healthcheck config'i ve readiness sonucu henüz yok. | Madde 45'in ilk diliminden sonra ele alınacak. |
| 16: ignored ayrımı | Ignored `!` kayıtları untracked `?` kayıtlarıyla birleşiyordu. | Bu dilimde tamamlandı. |
| 18: port probing | `endpoint-probe.ts` bir candidate için bind kontrolü yapıyor. | Transaction ve helper iletişimi birlikte incelenerek batch tasarlanmalı; bu dilimde değiştirilmedi. |
| 22–33: sunum/dağıtım | Bazı metadata ve doküman değişiklikleri zaten var. | Gerçek platform kanıtlarına göre güncellenmeli; Windows desteği doğrulanmadan sunumda tamamlanmış gösterilmemeli. |
| 34: docs parity | Hata kodları için parity testi vardı; komut/flag referansları için eşdeğer kontrol yoktu. | Bu dilimde eklendi; gerçek README hatası yakalandı. |
| 35: lifecycle parity | Removal, ranking, release ve event testleri farklı dosyalara dağılmış. | İlgili kabul kriterlerini testlerle eşleştirmek gerekiyor; tek bir başarılı testle başlık kapatılmamalı. |
| 45, 19: ortak iş kuyruğu ve RAM | Devam diliminde CLI/protocol/state/daemon ve skill birlikte uygulandı; sabit eşzamanlılık varsayılanı 1. | Native iki CLI/süreç ağacı kanıtı, gerçek makine bellek ölçümü ve belleğe göre iş başlatma açık. |

## Uygulanan değişiklikler

1. **Ignored dosyalar ayrı raporlanıyor.** `counts.ignored`, `paths.ignored` ve `ignored`
   classification'ı eklendi. `GIT_IGNORED_CONTENT`, silme reddinde exit 3 döndürüyor.
   Eski `untracked` alanından tüm yerel veriyi toplayan tüketiciler artık iki alanı okumalı.
   JSON zarfı sürümü değişmedi; proje 0.x sözleşmesi içindeki bu semantik değişiklik changelog'da açık.
2. **Removal entegrasyonu korundu.** Yalnızca tamamı temizlenecek ephemeral kaynakların içinde kalan
   ignored blocker ertelenebiliyor. Kaynak dışındaki kullanıcı verisi korunuyor; cleanup sırasında
   oluşan yeni ignored dosyayı ikinci analiz yakalıyor. Symlink hedefi takip edilmiyor.
   `lstat` sırasında yalnızca ENOENT kaybolmuş dosya sayılıyor; diğer hatalarda analiz duruyor.
   Geçersiz UTF-8 içeren porcelain verisi, dosya kimliğini değiştirerek kaybolmuş sanmamak için
   `GIT_REPOSITORY_DEGRADED` ile reddediliyor; geçerli Unicode dosya adları korunuyor.
3. **Komut dokümanları test ediliyor.** README, CLI reference, Agent Skill ve `examples/` altındaki
   Markdown dosyalarında inline/fenced komut referansları gerçek Commander kayıtlarıyla
   karşılaştırılıyor. Komutlar çalıştırılmıyor. Bilinmeyen komut, alt komut ve option yakalanıyor.
   README'deki `wtm skill --install` hatası `wtm skill install` olarak düzeltildi.
4. **TODO tutarlılığı düzeltildi.** Madde 16 ve 34 kapatıldı; mevcut create testlerinin doğruladığı
   dört checklist satırı güncellendi. Release checklist başlığı, dosyanın başındaki kararla uyumlu
   şekilde `v0.2.0` oldu. Native platform ve yayın kriterleri açık kaldı.

## Doğrulama ve sınırlar

- Bun 1.3.14 ve Node 24.19.0 kullanıldı; lockfile değiştirilmedi.
- Ignored ayrımı testleri implementasyon öncesinde beklenen nedenle başarısız oldu; değişiklik
  sonrasında geçti. Parity testi, README hatası düzeltilmeden önce onu raporladı.
- Seçilen parser, Git analysis/removal, global excludes, protocol, CLI JSON/exit, ranking,
  create ve documentation testleri: **15 dosyada 135 başarılı, 0 başarısız**. İzin hatası testi root koşullarında güvenilir
  chmod üretilemediği için tek filesystem çağrısını izole Node process'inde değiştiriyor;
  Git, CLI ve dosyanın korunması gerçek olarak doğrulanıyor.
- `bun run lint`, `bun run typecheck` ve build içeren `bun run package:verify` başarılı.
- **Tam test paketi başarılı kabul edilmedi.** İlk denemede, üretim kodu değiştirilmeden önce
  registered removal, lease ve process supervisor testleri başarısızdı; tekrar eden süreç
  hataları nedeniyle tam koşu durduruldu. Ortam kontrolü bir Node child için `process.pid=14`,
  `/proc/14/stat=ENOENT`, `/proc/self/stat=181208 (MainThread)` verdi. PID namespace ile procfs
  görünürlüğü uyuşmuyor; WTM süreç kimliğini bu ortamda güvenilir biçimde doğrulayamıyor.
- `bun run test:e2e` registered removal adımlarında `GIT_REPOSITORY_DEGRADED` ile başarısız.
  `bun run test:perf`: 19 test başarılı, 2 başarısız; daemon kullanan ölçümler başarılı değil.
  Bu hatalar atlanmış veya test beklentileri gevşetilmiş değil. Native CI tekrar çalışmalı.
- macOS Gatekeeper, Windows native davranışı, Linux ARM64 ve gerçek npm publish bu çalışma
  ortamında doğrulanmadı. Bu değişiklik bir release onayı değildir.

## Yeni ihtiyaç: eşzamanlı AI oturumlarında RAM baskısı

**İlk planlama kaydı, 2026-09-09:** Claude/AI oturumları ağır komutlarını bir skill üzerinden WTM'ye
göndersin; WTM sırayla çalıştırırken AI bağımsız işlere devam etsin. Bu ihtiyaç `todo.md`
madde 45 olarak P1'e eklendi. O anda yalnızca planlama değişikliğiydi; aşağıdaki devam
bölümünde uygulama ve doğrulama durumu ayrıca kaydedildi.

Kod incelemesi: `packages/cli/src/commands/run.ts` içindeki `runForegroundTask`, task'ı
`spawn` ile başlatıp exit olayına kadar bekliyor ve stdio'yu CLI'a bağlıyor. `start.ts`
daemon'a runtime isteği gönderiyor. `packages/core/src/state/store.ts` managed process
kayıtları barındırıyor; ayrı bir kalıcı job kuyruğu ve iş kabul sözleşmesi tanımlamıyor.
Bu nedenle yalnızca skill değişikliği yetmez; CLI, protocol, state ve daemon birlikte gelişmeli.

İlk dilim için mevcut daemon/SQLite üzerinde, aynı host ve kullanıcıdaki bütün repoların
paylaştığı kalıcı FIFO kuyruk ve varsayılan tek ağır iş slotu öneriliyor. Taslak
`wtm run <task> --enqueue --json` kabulden sonra `jobId` döndürür; agent durum, log ve
sonucu daha sonra okur. Mevcut foreground kullanım korunur. Her AI'ın kendi semaforunu
tutması oturumlar arası yükü sınırlamaz; ek kuyruk servisi ise yerel araca gereksiz yük ekler.

Bu tasarım build/test/typecheck gibi alt süreçlerin aynı anda çalışmasından doğan bellek
baskısını azaltmayı hedefler. Kullanıcının yaşadığı yükün ne kadarının bu komutlardan geldiği
henüz ölçülmedi; ilk adım temsili iki oturumda bellek dağılımını çıkarmaktır.
Claude'un kendi süreçlerinin RAM tüketimini doğrudan sınırlamaz;
WTM dışında başlatılan işler de bu kuyruğa dahil olmaz. Bir task kendi içinde çok sayıda worker
açabilir; ikinci dilimde task ayarları, bellek tahmini ve host'ta bırakılacak pay birlikte
değerlendirilmeli. Kesin RAM sınırı ve tasarruf oranı ancak platform desteği/ölçümle söylenebilir.

Agent'ın devam edebilmesi doğrulamanın doğruluğunu bozmamalı: queued/running işin okuduğu
dosyaları değiştirmek yerine kod okuma, planlama veya başka worktree'de bağımsız çalışma
sürer. Kaynaklar değişirse sonuç geçersiz sayılabilir; yalnızca HEAD kontrolü yeterli değildir.
Başarılı kabul yanıtı testin geçtiği anlamına gelmez; son durum ve exit code ayrıca okunur.
İptal, daemon restart, removal yarışı, sınırlı log/state ve iki oturumlu bellek ölçümleri
madde 45'in kabul kriterlerine dahil edildi. Otomatik agent bildirimi ayrı entegrasyon dilimidir.

## İlk analizde önerilen geliştirme sırası

1. **Native CI doğrulaması:** Bu dalın Git analizi ve removal değişikliklerini normal Linux,
   macOS ve Windows runner'larında çalıştır. Mevcut Windows sorunlarını ayrı takip et.
2. **Madde 45, ortak ağır iş kuyruğu:** Kalıcı job/IPC sözleşmesi, atomik slot yönetimi,
   hemen dönen CLI ve agent skill akışı. İlk dilimde sabit eşzamanlılık sınırı; sonra bellek
   farkındalığı. Native process doğrulaması gerekir; yayın hesabı işleri bunu bloke etmez.
3. **Madde 10, readiness:** Config şeması, template çözümleme, supervisor sonucu ve CLI
   `start --wait --timeout` tek bir sözleşmede tanımlansın. Timeout, erken process çıkışı,
   iptal ve tekrar start senaryoları kapsansın. HTTP/TCP ile process-liveness ayrımı açık olsun.
4. **Madde 7, disk tahmini:** Önce ölçüm semantiği ve I/O bütçesi, sonra ranking entegrasyonu.
5. **Madde 6, multi-repo create:** Feature identity, deterministik kilit sırası ve kalıcı
   recovery planı; kullanıcı verisini silebilecek kör rollback yapılmamalı.
6. **Platform/yayın kapanışı:** Windows ve Linux ARM64 kanıtlarıyla doküman/metadata eşleştirmesi,
   ardından Apple ve npm hesap erişimi gerektiren gerçek dağıtım kontrolleri.

P2 local domains, PR awareness, idle suspension ve TUI işleri bu temel doğrulamalardan sonra ele
alınmalı. Mevcut çalışan parçaları yeniden yazmak bu hedeflere katkı sağlamıyor.

## Ortak kuyruk uygulaması — devam oturumu

Çalışma dalı `codex/todo-safety-docs-parity`; devirdeki iki commit doğrulandı. Kullanıcının
son takip mesajı bu geliştirme dalına commit ve push yetkisi verdi. PR, merge ve release
yapılmadı. Git'te mevcut `user.name`/`user.email` korundu; coauthor satırı eklenmedi.

### Uygulanan sözleşme ve güvenlik

- **Tek scheduler:** Migration 012, mevcut SQLite ve daemon üzerinde FIFO job state ekler.
  Daemon global config'inde `[jobs].max_concurrent_heavy` varsayılan 1, aralık 1–64;
  repo override'ı bu limiti büyütemez. `queue=true`, `background!=true`, pozitif ve en fazla
  24 saat timeout gereklidir. `run` foreground ve `start` servis davranışı korunur.
- **Kapsam:** Aynı makine kimliği, UID/SID ve state veritabanı. Makine/kullanıcı kimliği
  uygulamaya özel digest olarak saklanır; yabancı kimlik, managed process recovery'den önce
  reddedilir. Ayrı state dizinleri ayrı limitlerdir. İlk legacy geçişinde eski host-local
  varsayımı devralınır; kayıtlara geriye dönük host kanıtı uydurulmaz.
- **Kabul ve sonuç ayrıdır:** `run --enqueue` kaynak/config ön kontrolünden ve kalıcı SQLite
  kabulünden sonra `jobId`, `state`, `accepted`, `idempotencyKey`, `reused` döndürür. Task
  bitişini beklemez. Retry için aynı anahtar; farklı kaynak/task fingerprint'i çatışmadır.
  İdempotency garantisi geçmiş kaydı tutulduğu süre içindir. JSON zarfı sürüm 1 korunur.
- **Atomiklik:** SQLite IMMEDIATE transaction admission, claim ve repository lease kontrolünü
  birbirini dışlayacak şekilde yürütür. Aynı worktree'de iki job başlamaz. FIFO'nun başındaki
  meşgul worktree arkadaki işleri bekletir. Pending/held job varken repository remove/GC/forget
  reddedilir; önce explicit cancel ve cleanup doğrulaması gerekir.
- **Süreç sahipliği:** Anchor PID ve managed record GO'dan önce kalıcı bağlanır. Başlatma sonucu
  veya süreç kimliği belirsizse slot tutulur. Restart sonucu belirsiz komutu yeniden başlatmaz.
  Completion marker numeric exit code, signal ve timeout kanıtını korur. Timeout anchor'da da
  uygulanır; daemon kapalıyken de deadline sürer. GO ve log hazırlığı sonunda deadline geçmişse
  child hiç spawn edilmez. Slot ancak süreç grubunun yokluğu doğrulanınca bırakılır.
- **Kaynak kanıtı:** HEAD, index, tracked/untracked içerik ve inode/mode/mtime/ctime/ancestor
  metadata hash'lenir. Ön kontrol, başlatma, tamamlanma ve sonuç okuma kaynak durumunu denetler.
  Limitler 10.000 dosya, 64 MiB içerik, 4 saniye, Git çıktısı başına 4 MiB; içerik 64 KiB
  buffer ile okunur. Symlink/submodule ve inceleme hatası fail-closed. Ignored/external girdiler
  kapsam dışıdır; bu atomik filesystem snapshot değildir ve geçici oluştur/sil işlemi kaçabilir.
  Büyük repo bu ilk dilimde güvenli biçimde reddedilebilir; HEAD eşitliği tek başına kanıt sayılmaz.
- **Sınırlı saklama:** En fazla 128 pending/held iş, terminal geçmiş hedefi 256 ve 7 gün,
  toplam sert kayıt sınırı 384. Prune enqueue sırasında; sonlandırılamayan cleanup sahipliği
  otomatik silinmez. Stream başına 1 MiB log + bir arşiv; sorgu stream başına 32 KiB.
  List çıktısı 128 KiB ve en fazla 100 iş; aynı anda en fazla iki admission ön kontrolü.
  Boş kuyruk için sürekli timer veya bellek taraması eklenmedi.
- **Agent akışı:** Skill enqueue → jobId saklama → okuma/planlama/başka worktree → seyrek status/log
  → terminal state + exitCode 0 + signal null + boşaltılmış slot + UNCHANGED kaynak sonucu
  doğrulamasını anlatır. CLI ayrıca yanıt iş kimliğini ve retry anahtarını istekle eşleştirir.
  Shell interception veya agent'ı kendiliğinden uyandırma iddiası yoktur.

### Bağımsız review ve giderilen bulgular

İlk iki subagent state/daemon ile CLI/skill sahipliklerini paylaştı; ağır kontroller yalnız ana
agent tarafından seri yürütüldü. CLI agent son review sırasında kullanım kotasına takılınca
ayrı bir reviewer görevlendirildi; aynı anda aktif agent sayısı ikiyi aşmadı.

Review ile ancestor symlink yarışı, Git output-limit kill timer'ı, IPC schemaVersion uyumsuzluğu,
başarısız süreç cleanup'ında sahiplik kaybı, pre-handshake anchor sahipliği, gecikmiş completion'ın
yanlış timeout olması, host guard'ının recovery sırası, legacy upgrade'da daemon'ı başlatmayı
engelleyen kilitlenme ve CLI signal/response identity kanıtları düzeltildi. Son review GO sırasında
deadline aşılması ve exit/stdio olay sırasının timeout sonucunu kaybettirmesini ayrıca ele aldı.
Tam testte bulunan gerçek SEA migration registry regresyonu düzeltildi; kaynak asset'leriyle
birebir byte-order karşılaştırması korunarak migration 012 beklentisi eklendi.

Son bağımsız kapanış review'inde incelenen kapsamda açık P1/P2 kalmadı. Local implementation
commit'leri: `22a38fe`, `e02ce15`, `b3e89f4`, `e40d417`, `02dfaa4`, `9a30d05`; ilk ilerleme
kaydı `5541fb8`. İlk `git push -u origin codex/todo-safety-docs-parity` denemesi
`could not read Username for 'https://github.com': No such device or address` ile reddedildi.
Terminalde Git credential helper yoktu. Bağlı GitHub hesabı `0furkancolak` olarak doğrulandı;
sunulan commit oluşturma API'si author/committer alanlarını veya mevcut yerel Git nesnelerini
yüklemeyi desteklemediği için ilk aşamada geçmiş değiştirilmedi.

Kullanıcı daha sonra “Bağlı GitHub hesabımla gönder” diyerek commit SHA ve
author/committer metadata değişikliğini açıkça yetkilendirdi. Bunun üzerine önceki iki devir
commit'i ve bu oturumun sekiz commit'i bağlı hesapla GitHub Git Data API üzerinden sırayla
yeniden oluşturuldu. Her commit'in Git tree SHA değeri yerel karşılığıyla birebir eşleşti:
dosya içerikleri, yolları ve modları korunuyor. Commit mesajları korundu; yeni coauthor
eklenmedi. Ortak başlangıç commit'i `2fbdd02b5abec90a79dc661dc9f069726cea9831`;
hedef geliştirme dalı `codex/todo-safety-docs-parity`. Yeni metadata nedeniyle SHA
üzerinden devir kontrolü yapan sonraki oturumlar aşağıdaki eşlemeyi kullanmalıdır.

| Önceki yerel commit | Bağlı hesapla oluşturulan GitHub commit'i |
| --- | --- |
| `816fb113998cff2f807f624c877ae097f2aa908a` | `6fff01922ff74daca23b746bced9ad2f0170f2b1` |
| `7962428cc27769c9b7f0500ccd9d269415233062` | `68d0ef2819bef25a6596ec2324bb2676bc83e1a6` |
| `22a38fe8ae068608a1d0c696e839882ed41f931b` | `5f5e91d997303504db13d586608bc2d926477f0c` |
| `e02ce1519118af4a4de848001d057af615a56ec4` | `10b087680c612c5d1820c06d75e36051ec8ce80a` |
| `b3e89f4f274ca732d637c6a39afd4ed9917495c3` | `b8af25aa684ddac3738d12ead11c57eb0d227d76` |
| `e40d417b64ce79c6815b543a93e0f9cda090f618` | `5c9887ecc60a8980380932445dde9da4acac276b` |
| `02dfaa4ba40c8bcfcd6f349838b4310a8e4d00aa` | `9435c279bb673a5f128db11f6db6693906db703b` |
| `9a30d0560ecd6f24a347bc8434e39d8edfc961d1` | `1afe5722c2777db326ed1f65334c4c66cfebd70d` |
| `5541fb8bed0c4855d3b460b42fb25b034b3fcc50` | `6cf195e804603768a38349097f69887c2b0d02d9` |
| `1e1a869dfe9384c971cbb3e9f3f5d549f243eb3c` | `a456e4f40105e05e4ab8892395f0adfbc705355f` |

Bu yayın kaydı, yukarıdaki on commit'ten sonra ayrı bir doküman commit'i olarak eklenir.
Bu işlemde ürün kodu veya test beklentileri değiştirilmedi; aşağıdaki doğrulama sonuçları
ve açık native platform/RAM kanıtları geçerliliğini korur. GitHub dalına gönderme izni,
PR açma, merge veya registry release izni anlamına gelmez.

### Bu ortamın sınırları ve sonraki iş

Son doğrulama kaydı (Bun 1.3.14, Node 24.19.0; komutlar seri çalıştırıldı):

| Kontrol | Sonuç ve sınır |
| --- | --- |
| Başlangıç `bun run test` | Kod değişmeden 420 pass / 49 fail kaydı; tamamlanmadı, durduruldu. Önceki oturumun yeşil sonucu devralınmadı. |
| Önceki güvenlik ve docs parity seçimi | 16 dosyada 137 pass / 0 fail; ignored/untracked, geçersiz UTF-8, inceleme hatası, removal guard, create ve protocol kapsamı. |
| Yeni protocol/config/source kanıtı | 6 dosyada 17 pass / 0 fail. Ancestor değiştir/geri koy yarışı ayrıca izole Node senaryosuyla testli. |
| Host/user kapsamı | 3 fixture testi pass; bu host'ta gerçek Linux kimlik okuyucu da değer üretti. macOS/Windows native kanıtı değildir. |
| Son state/daemon/anchor seçimi | 3 dosyada 7 pass / 0 fail. Gerçek SQLite child süreçleri, restart/timeout/cancel/source ve GO deadline kapsamı; scheduler süreç sınırı kontrollü. |
| Log ve supervisor güvenlik ekleri | Private completion/log testi pass; transient cleanup ve rejected anchor ownership için 2 supervisor testi pass. |
| CLI dahil kuyruk seçimi | 15 pass / 1 fail. Başarısız test production CLI socket açma aşamasında; retry/signal/response identity testleri pass. |
| Migration/SEA asset kontrolleri | Gerçek registry regresyonu giderildikten sonra 15 pass / 0 fail; byte-order ve asset kaynağı karşılaştırması korunuyor. |
| `bun run lint` | Başarılı. |
| `bun run typecheck` | Son timeout düzeltmeleri dahil başarılı. |
| `bun run test` | 300 saniye dış sınırında exit 124; 440 pass / 81 fail / 11 mevcut skip kaydı. Bu tamamlanmış bir test özeti değildir. İçindeki 12 SEA failure daha sonra yukarıdaki hedefli kontrolle düzeltildi; tüm paket yeniden yeşil sayılmadı. |
| `bun run test:e2e` | 0 pass / 2 fail: önceki registered removal `GIT_REPOSITORY_DEGRADED`; yeni iki gerçek CLI/iki repo senaryosu `listen EPERM`. |
| `bun run test:perf` | 19 pass / 2 fail; production daemon socket kullanan ölçümler `listen EPERM`, nihai performans raporu başarılı üretilmedi. |
| `bun run package:verify` | Build ve npm dry-run başarılı; 65 dosya. CLI bundle içindeki migration 012 ve dağıtılan skill mevcut. Dry-run registry publish değildir. |

Tablodaki hedefli gruplar örtüşebilir; test sayıları toplanarak ayrı test sayısı çıkarılmamalı.
Tam koşudaki her hata otomatik ortam hatası sayılmadı: yeni SEA mismatch gerçek regresyondu ve
düzeltildi; süreç/socket hataları taze doğrudan probe'larla incelendi. Test beklentileri
gevşetilmedi, yeni skip eklenmedi. Son küçük düzeltmeler hedefli olarak doğrulandı; tam suite'in
native süreç koşulları bu ortamda karşılanamadığı için release doğrulaması tamamlanmış değil.

Kullanıcının gerçek Claude/Codex makinesine erişim yok. Yerel `ps` komutu `fatal library error,
lookup self` verdi; taze Node probe'unda PID 2 ile `/proc/self/stat` PID 257572 uyuşmadı.
Minimal Node Unix listener ve yeni production queue E2E doğrudan `listen EPERM` verdi. Bunlar
bu yürütme ortamının kanıtıdır; kullanıcının Mac RAM tüketimi hakkında kanıt değildir.

Gerçek iki oturumlu önce/sonra ölçümü
`2026-09-09-heavy-job-memory-measurement.md` içinde tekrarlanabilir şekilde tarif edildi.
Tepe bellek/swap/baskı, toplam süre, daemon ek maliyeti ve task worker sayısı beraber ölçülmeden
RAM tasarruf oranı söylenemez. Sabit eşzamanlılık, sert bellek üst sınırı değildir.

Madde 45 bütünü kapatılmadı. Sıradaki işler: normal Linux/macOS runner'da gerçek socket ve
süreç ağacı, daemon kapalıyken timeout/restart kanıtı; kullanıcının iki AI oturumunda ölçüm;
sonra kullanılabilir bellek, task tahmini, diğer uygulamalara bırakılan pay ve task'ın worker
paralelliğini birlikte kullanan RAM dilimi. Otomatik agent bildirimi ayrı entegrasyondur.
Readiness (madde 10) sonraki ürün önceliği olarak kalır; native veya RAM kriteri tamamlanmış
gösterilerek başka başlık kapatılmaz. macOS/Windows/Linux ARM64 kanıtları ve registry release erişimi açık.

## Devam dilimi: native CI düzeltmeleri ve kuyruk bekleme nedenleri

Başlangıç: GitHub'daki `e79b625` ile temiz ve eşit yerel dal. İlk hedefli
protocol/config/state/daemon kontrolü 4 dosyada 9 pass / 0 fail verdi. Önceki doğrulama
sınırları devralınmadan yeniden ölçüldü: Node 24.19.0 `process.pid=5` bildirirken
`/proc/self/stat` PID 384210 verdi; yeni Unix listener yine `EPERM` ile reddedildi.
Bu ortamdan kullanıcının Claude/Codex RAM tüketimine ilişkin sonuç çıkarılmadı.

Bağlı GitHub hesabıyla önceki gönderimin [CI koşusu](https://github.com/0furkancolak/wtm/actions/runs/34351667016)
ve gerçek job logları okundu. Linux x64 1464 pass / 5 fail, macOS ARM64 ve x64
1468 pass / 5 fail bildirdi. Üçünde de aynı beş hata vardı; bunlar ortam sorunu sayılmadı:

| Bulgu | Kök neden ve düzeltme |
| --- | --- |
| İki SQLite test hatası | Tam migration listesi 11'de kalmıştı; migration 012 eklenerek tam sıralı eşitlik korunuyor. |
| Kuyruk native senaryosu | `node -e` içindeki JavaScript parantezleri WTM argv template'i olarak okunuyordu. Program her repo'da kaynak fingerprint'ine dahil `queue-check.cjs` dosyasına taşındı; production resolver değiştirilmedi. İki CLI kabul isteği bitmeden fixture cleanup başlamıyor. |
| Ignored removal testi | Eski `GIT_UNTRACKED` beklentisi `GIT_IGNORED_CONTENT` sözleşmesine geçirildi; exact count/path ve içerik/topoloji koruma kontrolleri tutuldu. |
| GC stderr uyarısı | Gerçek FileHandle sızıntısı: resource guard'ın sandbox/parent inode pinleri kapatılmıyordu. Guard `close()` kazandı; üretim GC ve tek seferlik authorization `finally` içinde kapatıyor. Test fixture'ları da aynı sahipliği izliyor. |

GC kapanışı yeni kontrolleri hemen reddeder, kabul edilmiş kontroller bitene kadar pinleri
tutar, sonra tamamını kapatır. Yol/inode güvenliği korunur. İzole Node testi gerçek açık
FileHandle nesnelerini izler; eski üretim GC senaryosunda 7 açık descriptor yakaladı.
Başarısız kurulum/inspection yolunda yeni açılmış pinler de kapatılır. Bağımsız review'ın
bulduğu boş test başarısı riski giderildi: test hem gerçek descriptor açılmasını hem de
üretim dry-run/apply sonuçlarının başarıyla tamamlanmasını şart koşar.

Bağımsız inceleme ayrıca iptal/finalizasyon yarışını yeniden üretti: süreç exit 0 verdikten
sonra son kaynak kontrolü beklerken kabul edilen iptal, eski `SUCCEEDED` kararıyla ezilebiliyordu.
`finish()` aynı `BEGIN IMMEDIATE` içinde güncel `stopReason` okur; iptal, doğrulanmış timeout
ve interruption sırası korunur. Exit code/signal kaybolmaz; sonuç kalıcılaştıktan sonraki iptal
geçmişi yeniden yazmaz. Eski sürümün bırakmış olabileceği `SUCCEEDED` + non-null `stopReason`
kaydı da sonuç okurken başarı sayılmaz; daemon ve CLI bağımsız olarak reddeder.

Madde 45'in sonraki küçük ürün dilimi `waitingReason` oldu. Atomik claim ve salt okunur
tanı aynı karar fonksiyonunu kullanır: önce `concurrency`, sonra `fifo`, sonra
`worktree_busy`, aksi hâlde `dispatch_pending`. Aktif kayıt sayısı admission ile 128'e
sınırlı; tek SQL snapshot kullanılır. Yeni migration, dependency, scheduler veya sürekli
bellek taraması eklenmedi. `dispatch_pending` repository/source kontrollerinin geçtiği
anlamına gelmez. Running/terminal kayıtlar `null`; eski daemon alanı atlıyorsa sebep bilinmez.
README, CLI reference, architecture, changelog ve dağıtılan skill aynı sözleşmeyi anlatır.

İki subagent analiz/implementasyon ve çapraz review yaptı; dosya sahiplikleri devredilmeden
aynı dosyada paralel yazılmadı. Ağır kontroller yalnız ana agent tarafından sırayla yürütüldü.
İptal yarışının yeni testleri düzeltme öncesi 3 pass / 5 fail, guard lifecycle 0 pass / 4 fail,
native task fixture 0 pass / 1 fail, waiting state/daemon 0 pass / 2 fail verdi; beklenen
eksik davranışları yakaladıkları doğrulandı. Düzeltmelerden sonra ilgili 12 test, GC/state/
fixture grubundaki 89 test ve kuyruk integration grubundaki 19 test başarılı oldu. Gruplar
örtüştüğü için sayıları benzersiz test toplamı gibi toplanmamalı.

Madde 45 bütünü, RAM ölçümü ve RAM tabanlı admission açık kalır. Readiness/healthcheck için
mevcut kod incelendi: task probe'u yok, IPC isteği varsayılan 5 saniyede kesiliyor ve managed
PID uygulama yerine ownership anchor'ını gösteriyor. Sonraki HTTP/TCP readiness dilimi bu
sınırları birlikte ele almalı; yalnız PID canlılığından “servis hazır” sonucu çıkarmamalı.

Önceki koşunun Windows x64 sonucu 1167 pass / 199 mevcut skip / 107 fail oldu.
Bu platform yeşil veya destek doğrulaması tamamlanmış sayılmadı. Native log incelemesi,
completion marker açılırken yalnız `O_NOFOLLOW` ve descriptor sahibine güvenmenin Windows'ta
symlink'i reddetmediğini gösterdi. Yeni izole Node testi bu davranışı Linux'ta da yalnızca
ilgili open çağrısının `O_NOFOLLOW` bayrağını kaldırarak yeniden üretti: gerçek symlink,
geçici symlink ve dosya değişimi testleri 4 fail; normal okuma/rotation kontrolleri 2 pass.
Üretim düzeltmesi explicit lstat ve açık descriptor/path kimliği karşılaştırması kullanır.
Kaynak parent yarış fixture'ı Windows için `dir` türü belirtir; open ve restoration gerçekten
olmadan geçmez. Kaynak snapshot'ın güvenli ret davranışı değiştirilmedi.

Windows'un diğer hata kümeleri önceki kuyruk kodundan önce de vardı: private-directory
ownership, POSIX anchor mode kontrolü, `/usr/bin/git`, Unix socket/path ve signal varsayımları.
Bu bulgular madde 9'daki açık platform işine aittir; yeni güvenlik hatasını bunlara bağlayıp
görmezden gelmek için kullanılmadı.

Bu dilimin geniş yerel test koşusu 300 saniye dış sınırında exit 124 verdi: 459 pass,
69 fail, 11 mevcut skip satırı. Bağımsız inceleme 43 socket/IPC hazırlık hatası, 18 process
kimliği/anchor hatası, 6 fail-closed registered removal sonucu ve 2 blocked-marker timeout'u
ayırdı. 49 hata önceki yerel baseline'da da vardı. Aynı isimli 68 test, önceki head'in üç
Linux/macOS native logunda başarılıydı; kalan yeni CLI kuyruk senaryosu burada `listen EPERM`
ile daha erken durdu. Bu karşılaştırma yeni head'in native kanıtının yerine geçmez.
`test:e2e` 0 pass / 2 fail (`GIT_REPOSITORY_DEGRADED`, `listen EPERM`), `test:perf`
19 pass / 2 fail (production socket `EPERM`) verdi. Nihai performans raporu üretilmedi.

Son kuyruk/GC/protocol/CLI/docs parity seçimi 10 dosyada 45 pass / 1 fail verdi; tek hata
production CLI'ın gerçek socket açtığı mevcut testte `listen EPERM`. Yeni bekleme nedeni,
geçmiş çelişkili sonuç, iptal/finalizasyon, descriptor lifecycle ve docs parity kontrolleri
başarılı. Source snapshot grubu 5 pass / 0 fail verdi. Test atlanarak yeşil sonuç üretilmedi.

Log güvenliğinin bağımsız review'ı ek bir rotation yarışı buldu: anchor `.generation`
dosyasını atomik değiştirirken yeni inode kontrolü normal cursor okumasını kesebiliyordu.
İlk/son marker açılışı ve segment kayması için yeni testler 6 pass / 4 fail ile bunu yakaladı.
Cursor okumasında yalnız tanımlı identity conflict mevcut üç denemelik sınır içinde yeniden
denenir; completion/launch okuması aynı uyuşmazlığı kesin olarak reddeder. Sürekli marker
değişimi sonsuz retry yapmadan başarısız olur; symlink/unsafe target benign rotation sayılmaz.
Son log/completion/cursor grubu 3 dosyada 32 pass / 0 fail verdi. Bağımsız takip review'ı
rotation P2 bulgusunu kapattı; bu dilimde açık P1/P2 bulgusu kalmadı. Fake file-trust kullanan
taşınabilir saldırı senaryoları native Windows ACL doğrulamasının yerine geçmez.

Son üretim koduyla `bun run lint` ve `bun run typecheck` başarılı. `bun run package:verify`
build ve npm dry-run adımlarını başarıyla tamamladı (65 dosya); migration 012 ve güncel skill
pakette yer alıyor. Bu sonuç registry yayını veya tüm native gate'lerin yeşil olduğu anlamına
gelmez. Yukarıdaki tam test/e2e/performance sınırları korunur; sonraki GitHub gönderiminin
native CI sonucu ayrıca izlenmelidir. Bu dilim yerel commit'lere ayrıldı; GitHub'a gönderim
kullanıcının mevcut yetkisiyle bağlı hesap üzerinden, aynı dosya ağaçları korunarak yapılır.

## Gönderim sonrası native doğrulama ve sonuç kanıtı takibi

Yedi commit bağlı GitHub hesabıyla `04b42bb` head'ine gönderildi; her commit'in tree SHA,
mesaj ve parent zinciri doğrulandı. Yerel dal uzak dalla eşitlendi; önceki yerel zincir
`codex/todo-safety-docs-parity-continuation-local-20260909` dalında korundu.
[CI koşusu 34357937422](https://github.com/0furkancolak/wtm/actions/runs/34357937422):

- Linux x64 tüm job adımlarını geçti: tam paket 1499 pass / 0 fail / 14 mevcut skip,
  e2e 2 pass / 0 fail, binary smoke 9 pass / 0 fail; lint/typecheck/build/package da başarılı.
  İki gerçek CLI süreci ve iki repository'nin tek daemon slotunu paylaşması, kalıcı kabul,
  CLI'ın işten önce çıkması, idempotent tekrar, sıralı yürütme ve gerçek sonuç/log okuması
  artık bu native Linux runner'da doğrulandı. Bu iki gerçek AI oturumu/RAM ölçümü değildir.
- macOS ARM64: 1501 pass / 2 fail / 10 mevcut skip. Kuyruk testinde ilk RUNNING/QUEUED ve
  tekrar kabul kontrolleri geçti; son SUCCEEDED beklemesi süreyi aştı. Diğer hata default HOME
  client senaryosunda stop yanıtı başarısızken data alanına erişilmesiydi. Gerçek hata zarfı
  eski fixture tarafından kaybedilmişti; iki hata da otomatik ortam sorunu sayılmadı.
- macOS x64 ve Windows x64 bu kayıt sırasında sürüyordu; sonuçları henüz başarı kanıtı değil.

İki fixture artık süre sınırı ve güvenlik assertion'larını değiştirmeden başarısız envelope'u
ve izinli alanlardan oluşan son job durumunu korur. Kuyrukta terminal başarısızlık varsa
15 saniye boşuna beklemek yerine nedeni bildirir; cleanup yine process slotu bırakılmadan
worktree silmez. Sonraki native koşu hata sınıfını göstermelidir; tanı düzeltmesi üretim
macOS sorununun giderildiği anlamına gelmez.

Bu incelemede ayrı ve tekrar üretilebilir sonuç kaybı bulundu: `completion?.exitCode ??
observed.exitCode` task'a ait geçerli null alanını anchor'ın exit code'uyla dolduruyordu.
Sinyalle biten task için null yerine 143, hiç çalıştırılmadan deadline nedeniyle reddedilen
task için null yerine 124 yazılabiliyordu; task'ın null signal alanı da sonraki anchor sinyaliyle
ezilebiliyordu. Üç yeni test düzeltme öncesi bu kaybı yakaladı. Daemon artık mevcutsa kalıcı
task completion çiftini bütünüyle kullanır, yalnız completion yoksa gözlenen anchor sonucuna
başvurur. İptal/timeout önceliği ve process grubu yokluğu kontrolleri korunur. İlgili dört
dosyada 9 test başarılı; bu hata henüz macOS native deadline'ın nedeni olarak kanıtlanmadı.
Bağımsız review'ın yeni testte bulduğu yanlış `members` alanı `pids: [101]` olarak düzeltildi;
son hedefli 3 test ve typecheck başarılı.

## Soğuk geliştirme çalıştırıcısının süreç grubu takibi

`4939b93` için [native koşu 34359907270](https://github.com/0furkancolak/wtm/actions/runs/34359907270)
Linux x64'te 1502 pass / 0 fail / 14 mevcut skip, e2e 2 pass ve binary smoke 9 pass verdi;
tüm job adımları başarılıydı. macOS ARM64 ve x64 aynı tek hatayı bildirdi: 1505 pass /
1 fail / 10 mevcut skip. Kuyruk task'ı exit code 0, signal null ve değişmemiş kaynakla
bitmişti; slot yaklaşık 10.65 saniye sonra TIMED_OUT olarak kapandı. Önceki default HOME
stop hatası bu koşuda tekrarlanmadı; nedeni kanıtlanmış veya düzeltilmiş sayılmadı.
Önceki `04b42bb` macOS x64 job'ı workspace-scale aşamasında 30 dakikalık job sınırında
iptal edildi; bu ayrı asılma sonraki koşuda tekrarlanmadı ve ortam hatası diye kapatılmadı.

İki bağımsız kod incelemesi `tsx` loader'ının soğuk cache'te başlattığı esbuild servisini
belirledi. Bu ortamda cache kapalı, yalnız gerçek process-anchor modülünü yükleyen ayrık
Node sürecinin altında esbuild gözlendi; `/proc` PID/PPID/PGID verisi yardımcı sürecin aynı
grupta olduğunu gösterdi. Bu ölçüm kullanıcının Claude belleğine ait değildir. esbuild
handle'larının unref edilmesi servisi kapatmaz; anchor'ın grup boşalma timer'ı da parent
çıkışını bekleyen servisi hayatta tutan döngüyü sürdürür. Deadline'da grup sinyali helper'ı
kapatınca task 0/null sonucu timeout ile birlikte kaydedilebilir. Native sonucun bu
mekanizmadan kaynaklandığı yeni koşuyla ayrıca doğrulanmalıdır.

Testkit artık gerçek özel CLI dispatcher'ını yönetilen grup kurulmadan önce küçük bir
JavaScript bundle'a derler. Node bu bundle üzerinden anchor, adapter ve endpoint modlarını
çalıştırır; süreç grubunda TypeScript derleyici servisi oluşmaz. Derleme her çağıran süreçte
bir kez, 30 saniye/SIGKILL ve sınırlı çıktı ile yapılır; geçici çıktı normal parent çıkışında
silinir. Paketlenmiş production çalıştırıcı ve süreç kimliği/grup yokluğu kuralları değişmez.
Native kuyruk e2e testi cache'i kapatarak aynı 10 saniyelik task deadline'ını korur.

Üç yeni regression testi gerçek child spawn'larını Node ve loader worker içinde gözler:
düzeltme öncesi üçü de esbuild'i yakalayıp başarısız oldu; düzeltmeden sonra üçü de geçti.
İlgili private dispatch/adapter güvenliği/scenario guard grubunda 48 pass / 0 fail alındı;
lint ve typecheck başarılı. Canlı native kuyruk sonucu bunlardan ayrı izlenir.

## Durdurma sonrasında gelen completion ve native yaşam döngüsü

Sonraki inceleme iki gerçek sonuç kaybını kontrollü olarak yeniden üretti: `stopRecord`
beklenirken yazılan completion'ın SIGTERM alanı ve `confirmStopped` lifecycle kilidini
beklerken gelen callback'in SIGKILL alanı eski null/null tuple yüzünden kaybolabiliyordu.
İlk iki yeni test 3 pass / 2 fail; bağımsız review'ın eklediği confirmation yarışı 1 fail
verdi. Kuyruk artık grup yokluğu → supervisor confirmation → taze completion/exit okuması
sırasını kullanır. Task'a ait null alanlar anchor alanlarıyla doldurulmaz; kabul edilmiş
iptal ve timeout nedenleri terminal transaction'da korunur. Son ilgili üç dosya 17 pass /
0 fail verdi; review bulguları giderildi.

Dört yeni native senaryo gerçek daemon, SQLite, fingerprint edilen Node task'ı ve onun
descendant'ıyla iptal, timeout, çalışan işte restart ve daemon kapalıyken tamamlanma yollarını
izler. Başlatma sayısı, idempotency, kodlanmış sonuç, kalıcı exit/signal, değişmemiş kaynak,
grup/çocuk yokluğu ve immutable terminal sonuç kontrol edilir. Kaynaklar ancak process
kimliğiyle doğrulanmış cleanup sonrasında silinir. POSIX'te gerçek SIGTERM completion
zorunludur; Windows force-stop'ta marker yoksa yalnız gerçekten gözlenen anchor çıkışı
veya bilinmeyen null/null kullanılır. Windows socket adresi gerçek named pipe'tır. Testler
atlamaz; 5/8 saniyelik task ve 30 saniyelik dış sınırlar yükseltilmedi. PowerShell başlatma
maliyetinin bu native Windows senaryolarını etkileyip etkilemediği henüz doğrulanmadı.
Bu ortamda ilk dört test socket açılışında `listen EPERM` verdi; task davranışına erişemedi.
Bu kayıt native başarı kanıtı değildir.

## Windows GC politika aktarımı ve yeni hata kanıtı

`04b42bb` Windows koşusu 1199 pass / 105 fail / 199 mevcut skip ile tamamlandı. Önceki
107 fail sayısının azalması platformu yeşil yapmaz. Yeni completion path güvenlik testleri
bu koşuda geçti; kaynak parent yarışı ve production GC fixture'ı hâlâ başarısızdı.

GC hatası üretim wiring'ine kadar izlendi: seçilmiş Windows file-trust politikası guard'a
aktarılmıyor, POSIX `getuid` fallback'i daha descriptor açılmadan RESOURCE_PATH_DENIED
veriyordu. CLI artık aynı seçilmiş policy instance'ını guard, apply ve journal recovery'ye
zorunlu input üzerinden taşır. Yalnız yazma izniyle private quarantine okuma/yazma kuralları
arasındaki mask farkı korunur; ACL kontrolü atlanmaz. Beş yeni test düzeltme öncesi 0 pass /
5 fail, düzeltme sonrası ilgili GC grubunda 15 pass / 0 fail verdi. Testler gerçek Windows
policy mantığını sınırlandırılmış fixture ACL okuyucusuyla çalıştırır; native Windows ACL
kanıtı değildir. Bağımsız review'da açık P1/P2 bulgu kalmadı.

Kaynak parent yarışının gerçek Windows hatası eski generic mesaj yüzünden henüz bilinmiyor.
Fixture şimdi yarıştan önce baseline snapshot alır; swap/open/restore aşaması ve yalnız
hata kodunu raporlar. Rejection regex, gerçekten link üzerinden açılma, restore ve kaynak
byte kontrolleri korunur. GC fixture'ı da null data erişiminden önce tam coded envelope'u
kontrol eder. Bu tanı değişikliklerinin bağımsız review'ı temiz; source/guard/docs parity
grubunda 19 pass / 0 fail alındı. Tanı eklemek native sorunu çözülmüş saymak değildir.

Readiness için `2026-09-09-readiness-next-slice.md` tasarım notu kaydedildi ve TODO 10'daki
örnekler açıkça uygulanmamış taslak olarak etiketlendi. Çalışan CLI belgelerine readiness
flag'i eklenmedi; TODO 10 ve madde 45'in RAM/gerçek AI oturumu kriterleri açık kalır.

Son üretim koduyla lint, typecheck ve package:verify başarılı (66 paket dosyası). Bağımsız
native test review'ında PID işaretinin başlangıç logundan önce görünmesi yarışı bulundu;
işaret artık stdout yazma callback'inde yayımlanır. İptal/timeout süreleri ve log assertion'ları
değişmedi. Yeni native koşu tamamlanana kadar yukarıdaki macOS/Windows doğrulama sınırları
geçerlidir; eski başarılı Linux koşusu son değişikliklere otomatik aktarılmaz.

## Üç native platformda kuyruk kanıtı ve completion doğrulama düzeltmesi

Altı commit bağlı GitHub hesabıyla `dbf7734` head'ine gönderildi. Her tree SHA, mesaj ve
parent zinciri yerel karşılığıyla doğrulandı; çalışma dalı uzak dalla 0 ahead / 0 behind
olarak eşitlendi. Yerel özgün commit'ler `codex/todo-safety-docs-parity-native-local-20260909`
dalında korundu. [CI koşusu 34364462861](https://github.com/0furkancolak/wtm/actions/runs/34364462861):

| Native runner | Tam test | E2E | Binary smoke | Job sonucu |
| --- | --- | --- | --- | --- |
| Linux x64 | 1517 pass, 0 fail, 14 mevcut skip | 2 pass | 9 pass | Başarılı |
| macOS ARM64 | 1521 pass, 0 fail, 10 mevcut skip | 2 pass | 9 pass | Başarılı |
| macOS x64 | 1521 pass, 0 fail, 10 mevcut skip | 2 pass | 9 pass | Başarılı |

Her üç job lint, typecheck, build ve package adımlarını da geçti. Cache kapalı iki CLI/iki
repo kuyruğu ve gerçek descendant içeren dört iptal/timeout/restart/downtime senaryosu üç
platformda da başarılı. Önceki macOS kuyruk timeout'u task deadline yükseltilmeden giderildi.
Madde 45'in süreç ağacı kriteri mevcut macOS/Linux kapsamı belirtilerek kapatıldı. Windows
bu kayıt sırasında sürüyordu; önceki `4939b93` Windows sonucu 1203 pass / 104 fail / 199
mevcut skip'ti. Windows ve gerçek iki AI oturumu RAM ölçümü yeşil kabul edilmedi.

Son bağımsız doğruluk incelemesi başka bir P1 buldu: completion okumasının JSON/kimlik/dosya
hatası `COMPLETION_UNREADABLE` olarak kaydediliyor, fakat gözlenen anchor exit code 0 daha
sonra SUCCEEDED ve error=null yazabiliyordu. İlk geçerli completion'dan sonra son okumanın
hata vermesi de aynı yanlış başarıya gidiyordu. Yeni yedi senaryo ilk koşuda 3 pass / 4 fail
verdi; başarısızlıklardan biri exit callback'i yokken ölmüş grubun slotunu bırakamamaktı.

Kuyruk artık okunamama kanıtını polling arasında korur; yalnız doğrulanmış, non-null bir
completion bunu temizler. Dosyanın sonradan kaybolması doğrulama sayılmaz. Grup yokluğu ve
supervisor confirmation sonrasında belirsiz iş INTERRUPTED/COMPLETION_UNREADABLE olur;
bilinen exit/signal korunur, kabul edilmiş cancel/timeout önceliği değişmez. Boşalmış slot
sonraki FIFO işine geçer ve başarısız sonuç tekrar çalıştırılmaz. Bağımsız review'ın bulduğu
cross-poll test boşluğu sekizinci `missing-next-poll` senaryosuyla giderildi; açık P1/P2
bulgu kalmadı. CLI reference ve architecture aynı sonucu anlatır. Bellek ölçüm tarifindeki
poll aralığı dağıtılan skill'in en az 10 saniyelik aralığıyla eşitlendi.

Son hedefli doğrulama 5 dosyada 35 pass / 0 fail; lint, typecheck ve package:verify başarılı
(66 dosya). Yukarıdaki native sonuçlar `dbf7734` içindir; bu son completion düzeltmesinin
yeni native koşusu ayrı izlenmelidir. Tam yerel paket/e2e/performance için önce kaydedilmiş
PID/proc ve socket sınırları geçerlidir; test beklentileri gevşetilmedi veya test atlanmadı.

## 2026-09-10 devam kaydı

Yeni HTTP readiness, cleanup disk tahmini, Windows private-directory ACL path düzeltmesi
ve sonraki RAM kabul tasarımı `2026-09-10-todo-continuation.md` içinde izleniyor. Buradaki
2026-09-09 sonuçları tarihsel baseline'dır; yeni değişikliklerin kanıtı yerine kullanılmaz.


## 2026-09-10 continuation and independent review

The historical results above remain scoped to their recorded revisions. Current continuation:

- [Review follow-up and native evidence](2026-09-10-review-follow-up.md): UDP descriptor
  closure, rotation-safe log recovery, bounded Linux mount evidence and native RAM admission.
- [Configured symlink policy](2026-09-10-symlink-policy.md): target-specific config, dedicated
  removal warning/blocker, real-Git refusal and independent review.
- [Windows follow-up](2026-09-10-windows-follow-up.md): native failures, strict ACL evidence,
  isolated pipe/profile paths and anchor authorization work.
- [Distribution follow-up](2026-09-10-distribution-follow-up.md): strict release evidence,
  local Linux x64 archives, FIFO regression and actual extracted WTM version smoke.

Numbered TODO headings currently mark 21/45 complete; checklist counts are not an estimate
of engineering effort. Native platform/distribution evidence and larger feature work remain.
