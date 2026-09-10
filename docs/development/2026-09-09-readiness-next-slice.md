# TODO 10: readiness için sonraki dilim

Bu belge 2026-09-09 tarihindeki tasarım kaydıdır. HTTP dilimi 2026-09-10'da uygulandı;
`start`/`restart --wait --timeout` ve task `healthcheck` config'i artık kayıtlıdır.
Aşağıdaki eski durum ve öneriler tarihsel gerekçedir. Güncel sözleşme CLI/config reference'ta,
doğrulama ve açık native/review kanıtları `2026-09-10-todo-continuation.md` dosyasındadır.

## Mevcut sınır

`packages/cli/src/commands/start.ts` ve runtime client yalnız cwd/taskName gönderir.
Daemon'ın LAUNCHED onayı uygulama portunun veya HTTP endpoint'inin hazır olduğunu göstermez.
Kaydedilen PID uygulamanın kendisine değil ownership anchor'ına aittir. Anchor cleanup ve
minimum yaşam süresi nedeniyle child'dan uzun yaşayabilir; PID canlılığından readiness
üretilmemelidir. Runtime controller ayrıca supervisor'ın döndürdüğü terminal record'u
başarı zarfında taşıyabilir; bu kaynak incelemesi native bir yarışın yeniden üretildiği
anlamına gelmez.

## İlk sözleşme

İlk uygulama HTTP probe ile `start` ve `restart` için sınırlı gözlem olmalıdır. TCP aynı
arayüzün sonraki küçük genişlemesi olabilir. `process` ve `command` probe'ları bu dilimde
uygulanmış gibi gösterilmemelidir; command probe ayrı subprocess sahipliği gerektirir.

| Alan | Önerilen davranış |
| --- | --- |
| Task config | Optional healthcheck: type=http, url, timeout, interval. URL mevcut template context ile çözümlenir. |
| CLI | Yeni `--wait`; yalnız bununla kullanılabilen `--timeout <duration>`. Varsayılan toplam gözlem 30 saniye; CLI override config'ten öncelikli. |
| IPC | Merkezi start/restart argüman şemasına optional wait ve waitTimeoutMs. |
| Normal start | Probe çalıştırmaz; mevcut process/existing alanlarına readiness=NOT_CHECKED eklenir. |
| Bekleyerek start | READY yalnız başarılı HTTP probe ve aynı managed record/identity tekrar doğrulandıktan sonra. |
| Hata | Timeout, duran/değişen process veya belirsiz kimlik için ok=false; process ve readiness verisi korunur. Yeni hata kodları protocol/exit mapping içinde kayıtlı olur. |
| Gözlem sonucu | Readiness state, probe type, attempt count, elapsedMs, observedAt; kimlik ve portun gelecekte hazır kalacağı sözü verilmez. |
| Timeout/disconnect | Gözlemi durdurur; managed servisi durdurmaz. Servis için ayrı stop komutu kullanılır. |

Eksik veya geçersiz healthcheck spawn/stop öncesinde reddedilmelidir. Özellikle hatalı
`restart --wait` mevcut çalışan servisi durdurmamalıdır. `existing:true` sonucu aynı
record üzerinde gözlenir; aynı task adına sahip yeni process eskisinin wait'ini tamamlayamaz.
Gözlem supervisor lifecycle lock'unu tutmaz; başka oturum stop/restart yapabilmelidir.

HTTP isteği hemen başlar, sonraki denemeler sınırlı aralıkla yürür. Monotonic deadline
launch onayından sonra başlar. Her HTTP isteği kalan süre içinde abort edilebilir olmalıdır.
2xx başarı sayılır, redirect otomatik izlenmez, kullanılmayan response body kapatılır.
URL, header veya config içindeki olası sırlar hata/context çıktısına taşınmamalıdır.
Bu kanıt endpoint'in o anda cevap verdiğini söyler; endpoint'in başka bir process tarafından
sunulmadığını tek başına kanıtlamaz.

## Taşıma katmanı bağımlılıkları

- DaemonClient bugün her isteği varsayılan 5 saniyede kesiyor. Readiness isteği için launch
  payı ve desteklenen maksimum deadline'ı kapsayan, üst sınırı belli per-request timeout
  gerekir; unrelated komutların timeout'u değiştirilmemelidir.
- IPC server handler'ları bugün bağlantı cancellation signal'ı almıyor. Disconnect/abort
  readiness probe ve timer'larını sonlandırmalıdır; managed process'i öldürmemelidir.
- Yeni SQLite migration, kalıcı health monitor servisi veya ikinci scheduler gerekmez.

## Dosya sahipliği ve testler

Ana agent protocol/config/task çözümleme, merkezi IPC wiring ve entegrasyonu sahiplenir.
Bir daemon agent observer/probe modülü ve controller entegrasyonunu, bir CLI agent flag,
wrapper ve request-timeout davranışını üstlenebilir. Ortak dosyalar önceden tek sahibine
atanmalı; ağır doğrulamalar ana agent tarafından sırayla yürütülmelidir.

Önce gerçek eksik davranışı gösteren testler yazılmalıdır:

- Geciken hazır endpoint, sürekli başarısız endpoint ve süresi dolan asılı HTTP isteği.
- Probe başarılı olurken process exit, identity belirsizliği veya aynı task'ın değiştirilmesi.
- existing=true durumunda yeniden spawn olmaması; geçersiz healthcheck'in restart stop'undan önce reddi.
- Normal start'ın probe yapmaması; timeout sonrasında managed servisin çalışıyor kalması.
- Disconnect sonrasında probe/socket/timer kaynaklarının kapanması.
- Gerçek CLI/IPC üzerinden beş saniyeden uzun süren başarılı wait.
- Template/duration/URL doğrulaması; tam JSON durumları, hata kodları ve doküman CLI parity.

TODO 10 ancak gerçek davranış ve native HTTP/IPC kanıtı alındığında işaretlenmelidir.
Bu not, TODO 45'in açık macOS/native süreç ağacı ve gerçek iki AI oturumlu RAM ölçümü
gereksinimlerini kapatmaz.
