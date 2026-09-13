# Ortak kuyruk bellek ölçümü: sonuçlar (2026-09-13)

Bu not, [`2026-09-09-heavy-job-memory-measurement.md`](2026-09-09-heavy-job-memory-measurement.md)
tarifinin tek bir gerçek makinede ilk uygulamasıdır. Madde 50'nin "kuyruk öncesi/sonrası tepe
bellek, bellek baskısı/swap, toplam süre ve WTM daemon ek maliyeti" kabul kriterini bu makine ve
bu görev seti için karşılar. Başka bir makineye, daha ağır bir göreve veya gerçek iki AI oturumuna
genellenemez.

## Ortam

- Makine: macOS, Apple Silicon (arm64), 10 çekirdek, 16 GiB RAM, 1 GiB swap.
- Node 24.18.0 (release binary'sinin sabitlediği sürüm), Bun 1.3.14.
- WTM: `f6d43aa`, `bun run build` ile üretilen `dist/cli/bin.js`. Kaynaktan `node --import tsx`
  ile başlatılan daemon kuyruktaki işi başlatamıyor; özel runner modları için yeniden çağırdığı
  giriş noktası tsx yükleyicisi almıyor ve iş `RUNTIME_START_FAILED` ile bitiyor. Testler bunu
  `developmentRuntimeInvocation()` ile aşıyor. Ölçüm, npm paketinin kullandığı build ile yapıldı.
- Yalıtım: geçici bir `HOME` (`/tmp/wtm-m50-*`), ayrı bir `wtm daemon serve`, kullanıcının
  gerçek WTM state'ine ve servislerine dokunulmadı. Aynı commit'ten iki bağımsız
  `git clone --shared` (`repo-a`, `repo-b`), her biri ayrı workspace olarak `wtm init` ile kayıtlı.
- Görev: her iki klonda aynı task.

  ```toml
  [tasks.typecheck]
  run = ["bun", "run", "typecheck"]
  queue = true
  timeout = "5m"
  memory_estimate_mib = 768
  ```

  `bun run typecheck` yedi `tsc --noEmit` projesini sırayla koşar. Tek koşu yaklaşık 7,5 sn sürer.
  En büyük tek süreç yaklaşık 590 MiB RSS'e çıkar (`/usr/bin/time -l`). Ölçümden önce iki klonda
  da bir ısınma koşusu yapıldı; bütün sonuçlar sıcak cache'tir.
- Makine boş değildi: kullanıcının Claude uygulaması ve oturumları (yaklaşık 3,4 GiB RSS) ile
  başka uzun ömürlü süreçler açıktı. Ölçüm boyunca dev server yoktu.

## Yöntem

Önce 60 sn boşta ölçüldü (daemon açık, iş yok). Sonra üç mod, her biri üç kez, sıra etkisini
azaltmak için dönüşümlü koşuldu: U1 Q1 M1, Q2 M2 U2, M3 U3 Q3. Koşular arasında 10 sn beklendi.

- **Kuyruksuz (U):** iki klonda aynı anda foreground `wtm run typecheck --json`.
- **Limit 1 (Q):** global config'te `[jobs] max_concurrent_heavy = 1`; iki klondan aynı anda
  `wtm run typecheck --enqueue --json`.
- **RAM kabulü (M):** `max_concurrent_heavy = 2` ve `[jobs.memory] budget_mib = 1152,
  reserve_mib = 1024`. Eşzamanlılık iki işe izin verir; bütçe 768 MiB'lik tahminden yalnızca
  birine yeter, yani işleri sıraya sokan bellek kabulüdür. Tahmin, U1'deki iki ağacın tepe RSS
  toplamının (1184 MiB) yarısının 1,25 katıdır, 64 MiB'e yuvarlanmıştır.

Her 0,5 sn'de bütün süreç tablosu (`pid, ppid, pgid, rss, comm`; argümanlar sır taşıyabileceği için
toplanmadı), `sysctl vm.swapusage`, `vm_stat` ve `memory_pressure -Q` örneklendi. Ağaçlar şöyle
ayrıldı:

- Kuyruksuz koşuda task ağacı, iki foreground CLI sürecinin torunlarıdır; CLI'ların kendisi ayrı
  sayıldı.
- Kuyruklu koşuda task ağacı, daemon'ın torunlarıdır: anchor `node` → `bun` → `bash` → `tsc`.
- Claude, çalıştırılabilir adında `claude` geçen bütün süreçlerdir.

Kuyruklu koşularda durum 2 sn'de bir `wtm jobs status` ile soruldu. Bu kısa ömürlü CLI süreçleri
ölçülen ağaçların dışındadır, ama sistem geneli bellek değerlerine dahildir.

RSS süreç başına toplanmıştır ve paylaşılan sayfaları birden çok kez sayar. Fiziksel bellek
tüketimi değildir; modlar arasındaki karşılaştırma için kullanılmıştır.

## Sonuçlar

Tablodaki değerler üç koşunun medyanıdır; aralık parantez içindedir. Kuyruklu modlarda "toplam
süre", ilk işin `createdAt` değerinden son işin `finishedAt` değerine kadardır. Kuyruksuz modda
toplam süre, iki CLI'nın başlatılmasından ikisinin de bitmesine kadardır.

| Ölçüt | Kuyruksuz | Limit 1 | RAM kabulü | Not |
| --- | --- | --- | --- | --- |
| İki task ağacının aynı anda tepe RSS toplamı | 1184 MiB (1153–1219) | 655 MiB (643–692) | 634 MiB (615–683) | Kuyrukla yaklaşık %45 düşük |
| Aynı anda çalışan task süreci (tepe) | 6 | 4–5 | 4–5 | |
| Foreground CLI istemcileri | 179 MiB (178–180) | yok | yok | Enqueue CLI'ı yaklaşık 0,3 sn'de çıkar |
| WTM daemon RSS, boşta / iş sırasında tepe | 92 / 92 MiB | 92 / 117 MiB (101–118) | 92 / 118 MiB (117–118) | Kuyruk işi daemon'a yaklaşık 25 MiB ekler |
| İki işin toplam süresi | 7,6 sn (7,3–8,8) | 14,9 sn (14,9–16,9) | 15,9 sn (14,9–15,9) | Sıralama süreyi yaklaşık iki katına çıkarır |
| Bekleyen işin kuyruk süresi | yok | 7,5 sn (7,5–8,4) | 7,5 sn | Öndeki işin çalışma süresi kadar |
| Tek işin çalışma süresi | yok | 7,4–8,5 sn | 7,4–8,5 sn | |
| Kabul gecikmesi (iki gönderim) | yok | 0,30 sn (0,26–0,30) | 0,31 sn (0,30–0,37) | Kalıcı kabul, CLI başlatması dahil |
| İlk gözlemde bekleyen işin nedeni | yok | `concurrency` (3/3) | `memory_budget` (3/3) | `jobs list`, gönderimden 1 sn sonra |
| Claude süreçleri RSS | 3,44–3,57 GiB | 3,40–3,57 GiB | 3,43–3,57 GiB | Moddan bağımsız, zamanla yavaş artış |
| Swap kullanımı | 1,31 MiB, değişmedi | değişmedi | değişmedi | |
| `memory_pressure` boş bellek yüzdesi, önce / en düşük | %70 / %68 | %69 / %68 | %69 / %68 | Baskı yok |
| Compressor | 2,76–2,94 GiB | 2,81–2,93 GiB | 2,82–2,91 GiB | Modla ilişkili bir eğilim yok |
| Terminal durum, exit code, kaynak | 6/6 exit 0 | 6/6 `SUCCEEDED`, 0, `UNCHANGED` | 6/6 `SUCCEEDED`, 0, `UNCHANGED` | |

RAM kabulü modunda daemon'ın bildirdiği bellek gözlemi: bütçe 1152 MiB, rezerv 1024 MiB,
kullanılabilir 6,0–6,2 GiB, toplam 16 GiB. Yani işi bekleten, makinenin boş belleği değil yapılandırılmış
bütçedir.

## Ne gösteriyor, ne göstermiyor

- **Gösterdiği:** Aynı anda iki ağır iş gönderildiğinde limit 1 de RAM kabulü de aynı anda çalışan
  task belleğini tek işe indiriyor. Bu görevde bu, iki ağacın tepe RSS toplamında yaklaşık
  530 MiB'lik bir fark. Bunun bedeli toplam sürenin yaklaşık iki katına çıkması. Kuyruk daemon'a
  yaklaşık 25 MiB ekliyor. Buna karşılık gönderen CLI çıktığı için, beklerken açık kalan foreground
  CLI'ların yaklaşık 180 MiB'i ortadan kalkıyor. Her iki gönderim de yaklaşık 0,3 sn'de `jobId`
  döndürüyor. Bekleyen işin nedeni doğru raporlanıyor. Bütün işler başarılı ve kaynak değişmemiş
  olarak bitti.
- **Göstermediği:**
  - Bu makinede bellek baskısı hiç oluşmadı: swap değişmedi, boş bellek %68'in altına inmedi.
    Kuyruğun swap'ı veya baskıyı azalttığı bu ölçümden çıkarılamaz; bunun için belleği gerçekten
    zorlayan bir görev veya daha küçük bir makine gerekir.
  - Görev hafiftir: tek bir `tsc` yaklaşık 600 MiB. Daha ağır görevlerde (tam test paketi, paralel
    worker'lı build) mutlak sayılar ve oranlar farklı olacaktır. Bir RAM tasarruf oranı vaat
    edilmemelidir.
  - İşleri iki CLI gönderdi, gerçek iki AI oturumu değil. Claude süreçlerinin RSS'i ayrı ölçüldü ve
    moddan etkilenmedi, ama oturumlar bu sırada iş göndermiyordu. Madde 50'nin "gerçek iki AI
    oturumu" kabul kriteri açık kalır.
  - Yarım saniyelik örnekleme kısa süreli tepeleri kaçırabilir.
  - Tek makine, tek işletim sistemi. Linux ve Windows ölçümü yok.
