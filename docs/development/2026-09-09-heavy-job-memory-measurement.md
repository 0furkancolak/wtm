# Ortak kuyruk için tekrarlanabilir bellek ölçümü

## Ölçümün sınırı

Bu oturum kullanıcının Claude/Codex makinesine erişmiyor. Yerel geliştirme ortamında `ps`
`fatal library error, lookup self` hatası verdi. Ayrı Node kontrolünde process.pid ile
`/proc/self/stat` PID'si farklıydı. Unix socket açma denemesi ayrıca `EPERM` / `listen`
sonucu verdi. Bu ortamdan kullanıcının RAM tüketimi veya tasarruf oranı çıkarılamaz.

Sabit eşzamanlılık bir RAM üst sınırı değildir. WTM yalnızca kendisine gönderilen işleri
sınırlar; Claude/Codex'in kendi süreçlerini, WTM dışında çalışan komutları veya bir task'ın
kendi içindeki worker sayısını sınırlamaz. Bu ilk dilim yeni bir bellek tarama servisi eklemez.

## Native macOS/Linux deneyi

1. Aynı commit'ten iki bağımsız worktree hazırlayın. İkisine aynı bağımlılık sürümlerini
   kurun; aynı lockfile, Node/Bun sürümü ve aynı task worker ayarları kullanın. Kayıtlı WTM
   task'larında `queue = true`, sonlu `timeout` ve `background != true` olsun. Ölçüm sırasında
   bu worktree'lerde dosya düzenlemeyin. Aynı state dizinini ve daemon'ı kullanın.
2. Önce Claude/Codex oturumlarını ve normal dev server'ları açık tutarak 60 saniye boşta
   ölçün. AI process'lerini, dev server süreçlerini ve WTM daemon PID'sini ayrı kaydedin.
3. **Kuyruksuz koşu:** iki terminalden aynı anda, her birinin kendi worktree'sinde aynı
   `wtm run typecheck` task'ını foreground başlatın. İki task'ın da exit code'unu kaydedin.
4. **Kuyruklu koşu:** global daemon config'inde `max_concurrent_heavy = 1` ile aynı iki
   task'ı `wtm run typecheck --enqueue --json` kullanarak gönderin. İki yanıtın jobId ve
   idempotencyKey alanlarını saklayın. Kabul gecikmesini task'ın toplam çalışma süresinden
   ayrı ölçün. Task'lar sürerken AI kod okuyabilir veya farklı worktree'de bağımsız iş yapabilir.
5. Gerekli olduğunda en az 10 saniye aralıklarla `jobs status` kontrol edin; uzun işler için
   daha seyrek kontrol edin. Tamamlanınca her iki
   `jobs result` JSON'unu ve gerekirse `jobs logs` çıktısını kaydedin. Başarı için terminal
   durum, sıfır exit code, bırakılmış slot ve değişmemiş kaynak kanıtı birlikte gereklidir.
   Sonuç başarısızken kabul yanıtını başarı kanıtı saymayın.
6. Aynı makinede koşuları en az üç kez, sıra etkisini azaltmak için dönüşümlü tekrarlayın.
   Soğuk ve sıcak cache ölçümlerini ayrı raporlayın; örneğin ilk bağımlılık indirmesini yalnızca
   kuyruksuz koşuya dahil etmeyin. İşlerin worker sayısı her iki koşuda aynı kalmalı.

### Gözlem araçları

- macOS: Activity Monitor'da Memory Pressure, Swap Used ve ilgili process'ler; terminalde
  `ps -axo pid,ppid,pgid,rss,comm`, `vm_stat` ve `sysctl vm.swapusage`. Process örneklerini
  saniyede bir almak yeterlidir; ayrıntılı argümanlar sır içerebileceğinden `args` toplamayın.
- Linux: `ps -eo pid,ppid,pgid,rss,comm`, `free -m`, `vmstat 1` ve mevcutsa `/proc/pressure/memory`.
  cgroup limiti varsa host belleğinden ayrı yazın. Yetki varsa PSS verisi RSS toplamına göre
  paylaşılan sayfaları daha iyi ayırır; yoksa RSS'yi kesin fiziksel bellek gibi adlandırmayın.
- Foreground task başına CPU/süre/peak RSS için macOS `/usr/bin/time -l`, GNU time mevcutsa
  Linux `/usr/bin/time -v` kullanılabilir. Enqueue CLI'ını time ile ölçmek yalnızca gönderim
  istemcisini ölçer; daemon'ın daha sonra başlattığı task'ın belleğini ölçmez.

Her task'ın alt süreçlerini PPID/PGID ağacından izleyin; yalnızca ana Node PID'sine bakmak
test worker'larını kaçırır. PID yeniden kullanımına karşı süreç başlangıç zamanlarını da
kaydedin. Toplanan çıktılar süreç adları gibi yerel bilgi içerebilir; rapora yalnızca gereken
özetleri ekleyin.

## Rapor şablonu

| Ölçüt | Kuyruksuz | Limit 1 | Not |
| --- | --- | --- | --- |
| AI süreçlerinin boşta / tepe RSS'si | Ölçülecek | Ölçülecek | Ağır task'lardan ayrı |
| İki task ağacının aynı anda tepe RSS toplamı | Ölçülecek | Ölçülecek | Paylaşılan sayfalar çift sayılabilir |
| WTM daemon boşta / tepe RSS'si | Ölçülecek | Ölçülecek | Snapshot, SQLite ve log maliyeti dahil |
| Dev server RSS'si | Ölçülecek | Ölçülecek | Queue slotu kullanmaz |
| Sistem bellek baskısı ve swap değişimi | Ölçülecek | Ölçülecek | OS / cgroup bağlamı belirtilmeli |
| Kabul gecikmesi | Uygulanmaz | Ölçülecek | Kalıcı kabul süresi |
| Her task'ın çalışma / kuyrukta bekleme süresi | Ölçülecek | Ölçülecek | createdAt / startedAt / finishedAt |
| İki işin toplam bitiş süresi | Ölçülecek | Ölçülecek | RAM azalırken uzayabilir |
| Terminal durum / exit code / sourceValidity | Kaydedilecek | Kaydedilecek | Başarısız koşu hız kazanımı sayılmaz |

RAM farkındalığı dilimi bu ölçümden sonra task tahmini, kullanılabilir bellek, diğer
uygulamalara ayrılacak pay ve task worker paralelliğini birlikte değerlendirmelidir.
Otomatik agent bildirimi ve bütün terminal komutlarını yakalama bu kuyruğun özelliği değildir.
