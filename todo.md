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

**2026-09-09 analiz ve ilk geliştirme dilimi:**
[`docs/development/2026-09-09-todo-analysis.md`](docs/development/2026-09-09-todo-analysis.md).
Madde 16 ve 34 tamamlandı; kalan P0/P1 bağımlılıkları ve doğrulama sınırları bu notta.
Eşzamanlı AI oturumlarının ağır komutlarından doğan RAM baskısı için madde 50, P1'e eklendi;
ortak iş kuyruğunun sabit eşzamanlılık dilimi uygulandı. Devamında iptal/finalizasyon yarışı,
GC descriptor sızıntısı ve native CI fixture uyumsuzlukları giderildi; bekleme nedenleri eklendi.
`04b42bb` Linux x64 CI tam test/e2e/binary/package adımlarını geçti; macOS takip bulguları
ve gerçek iki AI oturumlu RAM ölçümü açık. Kalıcı task exit code/signal çiftinin anchor
sonucuyla karışması ayrıca düzeltildi; yeni native koşu kanıtı takip ediliyor.

**2026-09-10 devamı:** `docs/development/2026-09-10-review-follow-up.md` ve
`docs/development/2026-09-10-symlink-policy.md` yeni düzeltmelerin, review ve doğrulamanın kaydıdır.
Windows native bulguları ve takip yamaları: `docs/development/2026-09-10-windows-follow-up.md`.

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
- [~] `remove`, `gc`, destructive cleanup ve ileride `repair` gibi operasyonlarda aynı mekanizmayı
      kullan. — `remove` (`remove-worktree.ts`) ve `gc --apply` (`resources/gc.ts`) ikisi de
      `withRepositoryOperationLease`'i kullanıyor ve artık **birbirlerini de** dışlıyorlar
      (aşağıdaki kabul kriterine bak); `repair` diye ayrı bir komut henüz yok, o yüzden hâlâ
      implement edilmemiş — bu satır bilerek açık kalıyor. `RepositoryOperation` tipi zaten
      `'remove' | 'gc' | 'repair'`, ve genişletilmiş conflict kontrolü satır bazlı değil
      repository bazlı olduğu için `repair` komutu yazıldığı gün ek bir değişiklik gerektirmeden
      doğru davranacak.
- [x] Lock conflict için stable JSON error code ekle.

#### Önerilen hata kodu

```text
WTM_OPERATION_CONFLICT
```

#### Kabul kriterleri

- [x] İki terminal aynı repository üzerinde destructive işlem başlatamıyor.
- [x] CLI ve daemon aynı repository üzerinde çakışan destructive işlem yapamıyor. — kapandı:
      `acquireRepositoryOperationLease` (`packages/core/src/state/sqlite-store.ts`) artık
      `repository_id`'nin **bütün** lease satırlarına bakıyor, sadece istenen `operation`'ın
      satırına değil; şema ve primary key (`{repository_id, operation}`) bilerek değişmedi.
      Liveness ölçümü politika katmanında da genişledi
      (`packages/core/src/analysis/operation-lease.ts` + yeni
      `StateStore.listRepositoryOperationLeases`), yoksa ölü bir `gc` satırı bir `remove`'u
      sonsuza kadar bloke ederdi. Hata bağlamına `holderOperation` eklendi: `remove` isteyen bir
      kullanıcı artık yolunu kesenin `gc` olduğunu görüyor (`docs/18-errors-json-contract.md`).
      **Kanıt (CLI `remove` vs daemon `gc`):** `packages/cli/src/__tests__/remove-runtime.test.ts`
      → "refuses the daemon's own lease acquisition while a CLI remove holds the repository",
      `daemon-lease-conflict.scenario.ts` üzerinden — gerçek `wtm remove` process'i lease'i
      tutarken ayrı bir OS process'i olarak çalışan daemon kompozisyonu `gc` istiyor ve
      `WTM_OPERATION_CONFLICT` / `holderOperation: 'remove'` alıyor (`daemonGc*` alanları).
      Destekleyen testler: `sqlite-store.test.ts` → "refuses a remove while a gc holds the
      repository, and never resumes one from the other" (store katmanı, iki ayrı SQLite
      bağlantısı), `gc-repository-lease.test.ts` → "refuses the whole apply while a CLI remove
      holds the repository" (`gc --apply` tarafı), `removal-lifecycle.test.ts` → "refuses the
      removal outright while the daemon's gc holds the repository" (`remove` tarafı),
      `operation-lease.test.ts` → dört yeni cross-operation testi.
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

### [x] 4. Performance release gate davranışını netleştir

Dokümantasyon ile workflow aynı şeyi söylemeli.

#### Karar

Aşağıdaki iki yaklaşımdan biri seçilmeli:

#### Tercih edilen: gerçek release gate

- [x] ARM64 performance job release öncesi zorunlu olsun.
- [x] x64 performance job release öncesi zorunlu olsun.
- [x] Publish job performance sonuçlarına `needs` ile bağlı olsun.
- [x] Stable release performance blocker varken yayınlanmasın.
- [x] Prerelease için ayrı policy gerekiyorsa açıkça tanımla.

Önerilen akış:

```text
verify-arm64
verify-x64
performance-arm64
performance-x64
        ↓
      publish
```

Gerçekte uygulanan akış yukarıdakinden kasıtlı olarak farklı: ayrı `performance-arm64`/
`performance-x64` job'ları açmak yerine, ölçüm zaten var olan `verify` matrix job'unun İÇİNE
eklendi — aynı iki runner'ı (macOS arm64/x64) tekrar açmadan, `publish`'in zaten `needs: verify`
ile bağlı olduğu job'a bir adım daha eklemek yeterliydi. Sonuç aynı: performance ölçümü
`publish`'ten önce koşuyor ve `publish`'in kendisi `needs: verify` üzerinden dolaylı olarak ona
bağlı — ayrı bir `needs: performance` gerekmedi çünkü performance artık `verify`'ın bir parçası.

#### Alternatif

- [ ] Performance testlerini "release gate" olarak tanımlayan dokümantasyonu değiştir.
- [ ] Bunları yalnızca monitoring/report olarak adlandır.

#### Kabul kriterleri

- [x] Workflow ve docs aynı davranışı tarif ediyor. — docs/14 ve docs/05 zaten "release gate"
      diyordu; şimdi gerçekten öyle.
- [x] Performance blocker'ın release üzerindeki etkisi deterministic. — `scripts/verify-release.ts`'in
      yeni `verifyPerformance`'ı: stable release + en az bir blocker → release reddedilir (hata
      mesajında blocker sayısıyla); prerelease → blocker olsa bile yayınlanabilir (aynı `verifySigning`'in
      unsigned executable'a prerelease için tanıdığı muafiyetin aynısı, aynı gerekçeyle: prerelease'in
      kendisi bir düzeltmeyi ölçmenin tek aracı, onu reddetmek düzeltmeyi ölçecek hiçbir şey bırakmaz).

**2026-09-10 düzeltmesi:** Performance report script'indeki yanlış testkit import yolu,
ölçüme başlamadan ERR_MODULE_NOT_FOUND üretiyordu. Yol düzeltildi; gerçek script girişini,
JSON dosyasını ve blocker/exit-code eşleşmesini doğrulayan iki test eklendi (ölçümler fixture).
Native performans bütçesi bu ortamda Unix socket kısıtı nedeniyle hâlâ doğrulanamıyor.

**2026-09-10 yayın kanıtı takibi:** Negatif bir sayaç başka rapordaki blocker'ı sıfırlayabiliyordu.
Public verifier ve CLI JSON sınırı artık iki sayacı da negatif olmayan güvenli tam sayı olarak
doğrular; toplam `BigInt` ile kayıpsızdır. Boş/yinelenen/yayımlanmayan arşiv seçimleri de reddedilir.
Altı davranış regresyonu RED→GREEN doğrulandı; geçerli prerelease istisnası korundu.

**Çözüldü:** 2026-09-06. `performance.yml` ayrı workflow'u kaldırıldı (kimsenin bakmadığı bir yerde
koşuyordu); ölçüm `release.yml`'in `verify` job'una taşındı, `dist/release/PERFORMANCE.json` olarak
diğer kanıtlarla (SIGNING, SMOKE.json) aynı şekilde taşınıp `publish`'te birleştiriliyor,
`verify-release.ts`'in `verifyPerformance`'ı gerçek gate kararını veriyor.
`scripts/__tests__/verify-release.test.ts` ve `scripts/__tests__/release-workflow.test.ts` yeni
davranışı doğruluyor.

---

### [ ] 5. Stable macOS release için notarization ekle

Developer ID signing tek başına stable macOS dağıtımı için yeterli değil.

#### Yapılacaklar

- [~] Apple notarization credentials/secrets ekle. — secret **isimleri seçildi ve workflow'a
      bağlandı**, ama secret'ları yalnızca repo sahibi ekleyebilir (Apple ID bir agent'ın
      edinebileceği bir şey değil). GitHub'a eklenecek üç secret:
      `MACOS_NOTARIZATION_APPLE_ID`, `MACOS_NOTARIZATION_PASSWORD` (**app-specific password** —
      App Store Connect tüm hesaplarda 2FA zorunlu kıldığı için hesap parolası çalışmaz),
      `MACOS_NOTARIZATION_TEAM_ID`. Şekil, Apple'ın güncel dokümantasyonuna karşı 2026-09-07'de
      doğrulandı (spec'in "Credentials" bölümü alıntıları taşıyor); `altool` 1 Kasım 2023'ten beri
      desteklenmiyor, `notarytool` tek yol.
- [x] `xcrun notarytool submit` pipeline'ı ekle. — `.github/workflows/release.yml`, "Notarize the
      executable" adımı. İmzalama adımının desenini birebir izliyor: credential yoksa
      `notarization=skipped`, iş **başarısız olmuyor** (Apple hesabı olmayan bir katkıcı hâlâ
      prerelease build edebiliyor). Ad-hoc imza da atlanıyor — notary service yalnızca Developer
      ID imzalı kodu kabul ediyor. `--wait` kullanılıyor ve dönen `status` açıkça okunuyor;
      `Accepted` değilse `notarytool log` stderr'a dökülüp adım kırmızıya düşüyor.
- [x] Notarization sonucu başarılı olmadan stable release'i yayınlama. — `verifyNotarization`
      (`scripts/verify-release.ts`), `verifySigning` ile aynı kural: stable release
      `notarization !== 'notarized'` ise publish edilmiyor. `WTM_RELEASE_NOTARIZATION` hem
      per-architecture `verify` gate'ine hem `publish`'in birleşik gate'ine bağlandı ve
      `release-workflow.test.ts`'in `required` dizisine eklendi (bağlantı koparsa test kırmızı —
      negatif olarak doğrulandı).
- [x] Gerekiyorsa artifact paket formatını notarization'a göre düzenle. — **Gerekmiyor, ve bu
      Apple dokümantasyonuna karşı doğrulandı, tahmin değil.** Notary service yalnızca UDIF disk
      image, imzalı flat installer package ve ZIP kabul ediyor, çıplak Mach-O kabul etmiyor —
      bu yüzden executable *yalnızca submission için* zipleniyor (`ditto -c -k`, `RUNNER_TEMP`
      altında, yayınlanmıyor). Dağıtım formatı değişmiyor: release hâlâ aynı `.tar.gz`.
      Stapling bir seçenek değil, Apple'ın kendi ifadesiyle: *"Although tickets are created for
      standalone binaries, it's not currently possible to staple tickets to them."* Yani
      Gatekeeper ticket'ı çevrimiçi arayacak — ilk çalıştırmada ağ erişimi gerekiyor. Bu bir
      kısayol değil, `.pkg`/`.dmg`'ye geçmeden mümkün olan tek şey.
- [~] `spctl --assess` doğrulaması ekle. — adım yazıldı ("Verify Gatekeeper accepts the
      executable", `spctl --assess --type execute --verbose=2 dist/sea/wtm`, notarization
      atlandıysa kendisi de atlanıyor), ama **hiç çalışmadı**: credential olmadan çalıştıracak
      bir notarize edilmiş artifact yok. Gerçek çıktı ancak secret'lar eklenip bir tag
      push'landığında görülecek.
- [~] Gatekeeper verification testleri ekle. — CI tarafındaki test yukarıdaki `spctl` adımı; onun
      dışında lokal olarak yazılabilecek bir Gatekeeper testi yok (runner'ın kendisi temiz
      makine rolünü oynuyor). Gate'in mantığı `verify-release.test.ts`'te dört testle kapalı
      (evidence yok / stable notarize değil / prerelease skipped / stable notarized), ama bunlar
      gate'i test ediyor, Gatekeeper'ı değil.
- [x] Release dokümantasyonunu güncelle. — docs/12 artık mevcut signing/notarization/performance
      gate'ini, prerelease istisnalarını ve online lookup üzerine kurulan workflow kontrolünü
      açıklar. Gelecek artifact'ın ilk çalıştırma/offline kabulü doğrulanmış gibi sunulmaz;
      gerçek Gatekeeper kanıtı gelene kadar aşağıdaki workaround korunur.
- [ ] Quarantine workaround'unu kaldır: `README.md` ve `CHANGELOG.md` içinde
      `<!-- gatekeeper-quarantine:start -->` / `<!-- gatekeeper-quarantine:end -->` ile
      işaretli bölümler. `scripts/__tests__/gatekeeper-workaround.test.ts` yarım kaldırmayı
      kırmızıya düşürür; her iki bölüm de gidince o test dosyası da aynı değişiklikte silinir.
      **Bilerek yapılmadı.** Plan'ın kendi "What to hand back if credentials are never added"
      bölümü tam olarak bu durumu tarif ediyor: gerçek bir `spctl --assess` yeşili olmadan
      workaround'u kaldırmak, hâlâ var olan bir kusuru belgesiz bırakır. Workaround ve testi
      olduğu gibi duruyor.

#### Kabul kriterleri

- [ ] Stable artifact temiz macOS makinede Gatekeeper tarafından kabul ediliyor. — **doğrulanamadı.**
      Bunun için gerçek Apple Developer credential'ları GitHub secret olarak eklenmeli ve bir tag
      push'lanmalı; ikisi de yalnızca repo sahibinin yapabileceği şeyler. Kod ve workflow hazır ve
      credential'sız hâliyle yeşil.
- [ ] Stable release notarization yoksa publish edilmiyor. — gate yazıldı, bağlandı ve testlerle
      kapatıldı (yukarıya bak), ama gerçek bir tag koşusunda hiç çalışmadı. Bugün pratikte şu
      anlama geliyor: secret'lar eklenene kadar **stable release publish edilemez** (gate
      `skipped`'ı reddeder); prerelease etkilenmiyor. Bu, kriterin istediği davranış — ama
      "gerçekten çalıştı" kanıtı bir release koşusundan gelmeli.

---

## P0 — `v0.1.0-rc.1` alan testi bulguları

Bu bölümdeki maddeler, yayınlanmış `v0.1.0-rc.1` arm64 arşivi indirilip izole bir `HOME` altında
uçtan uca çalıştırılarak bulundu. Aracın kendisi çalışıyor: `init`, `status`, `doctor`, `detect`,
`env`, `resolve`, `start`, `ps`, `stop`, `logs`, `analyze`, `remove` doğrulandı; iki worktree'ye
`3000` ve `3001` portları çakışmadan verildi; `remove` untracked dosya varken `GIT_UNTRACKED` ve
`GIT_HEAD_NOT_REMOTE_PERSISTED` ile reddetti. Aşağıdakiler o çalıştırmada çıkan kusurlar.

Numaralandırma dosyanın sonundan devam ediyor; mevcut madde numaraları kasıtlı olarak
değiştirilmedi.

**Bir sonraki tag'den önce:** yalnızca 36; 37 ve 45 kapandı. 36 kod değil, paketleme ve
dokümantasyon işi ve Apple kimlik bilgilerini (notarization secret'ları) bekliyor. 45 (daemon'ı
yedi gün boyunca sessizce ayağa kaldırmayan crash döngüsü) 2026-09-11'de kapandı.

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

- [x] README install bölümüne tarayıcıyla indirme uyarısı ekle.
- [x] Geçici çözümü belgele: `xattr -d com.apple.quarantine wtm`.
- [x] Prerelease notlarına aynı uyarıyı koy. `release.yml:184` release gövdesini
      `--notes-file CHANGELOG.md` ile yayınlıyor, yani README ile changelog tek kaynağın iki
      görünümü; ikisi de `gatekeeper-quarantine` işaretleri arasında.
- [x] Sessiz SIGKILL yerine anlaşılır bir hata üretmenin mümkün olup olmadığını araştır.
      **Cevap: mümkün değil.** Kill `exec` anında, WTM'nin hiçbir kodu çalışmadan önce oluyor;
      süreç içinden basılabilecek bir hata yok. Bu, dokümantasyona da yazıldı — üçüncü kez
      araştırılmasın.
- [x] Kalıcı çözüm için 5. maddeye (Developer ID + notarization) bağla.

#### Kabul kriterleri

- [x] Tarayıcıyla indiren kullanıcı README'de ne yapacağını buluyor.
- [ ] Notarization tamamlandığında bu geçici çözüm dokümandan kaldırılıyor. Kalan tek kriter
      bu; 5. maddede kaldırma adımı ve yarım kaldırmayı yakalayan test yazılı, madde o zaman
      kapanır. — **Hâlâ açık, bilerek.** Notarization pipeline'ı ve gate'i 5. maddede yazıldı
      (`release.yml`'de `notarytool submit` + `spctl --assess`, `verify-release.ts`'te
      `verifyNotarization`), ama notarization henüz *tamamlanmadı*: Apple credential'ları secret
      olarak eklenmediği için hiç bir artifact notarize edilmedi. Kriterin koşulu ("notarization
      tamamlandığında") gerçekleşmedi, dolayısıyla workaround `README.md`/`CHANGELOG.md`'de ve
      `scripts/__tests__/gatekeeper-workaround.test.ts` yerinde duruyor. Kaldırma, gerçek bir
      notarize edilmiş release koşusundan sonra yapılacak tek bir değişiklik.

---

### [x] 37. README quick start ilk denemede çalışmıyor

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

- [x] Görev tanımlama adımı quick start'ın içine alındı. `make:dev` yeniden adlandırması
      **çözüm değil**: `make:` görevleri yalnızca workspace'te o hedefi taşıyan bir `Makefile`
      varken oluşuyor (`packages/adapters/src/make.ts:54`), temiz bir workspace'te yeni ad da
      eskisi gibi başarısız oluyor.
- [x] `wtm resolve` ve `wtm start` hata mesajı bilinen görevleri listelesin. İkisi de aynı
      `resolveTask` çağrısına düşüyor; mesaj yazılana en yakın 10 adı sıralıyor ve kalanı
      "and N more" ile sayıyor.
- [x] Hiç görev bulunmayan workspace'te mesaj görevin nasıl tanımlanacağını söylesin.
- [x] README'deki her komutun temiz bir workspace'te çalıştığını doğrulayan test ekle
      (`packages/cli/src/__tests__/quick-start.test.ts`; komutları README'nin kendisinden
      okuyor, kendi kopyasını taşımıyor).

#### Kabul kriterleri

- [x] README'yi baştan sona uygulayan kullanıcı hiçbir adımda hata almıyor.
- [x] `Unknown task` hatası kullanıcıya mevcut görevleri gösteriyor.

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

### [x] 39. Daemon socket hatası ham stack trace basıyor ve CI yollarını sızdırıyor

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

- [x] Soket yolu uzunluğunu bind etmeden önce kontrol et (`packages/core/src/paths/daemon-socket.ts`;
      yayınlanan ve bind edilen adresin uzunu ölçülüyor, bayt olarak).
- [x] Sınır aşıldığında `WTM_` kodlu, ölçülen uzunluğu ve sınırı söyleyen bir hata üret
      (`WTM_SOCKET_PATH_TOO_LONG`, exit 2, hem `serve` hem `install` yolunda).
- [x] Çözüm önerisini mesaja koy (daha kısa bir `HOME` veya yapılandırılabilir runtime dizini).
- [x] Kullanıcıya giden hiçbir hatanın build-time yol sızdırmadığını doğrulayan test ekle
      (`packages/cli/src/commands/__tests__/daemon-serve-failure.scenario.ts`).
- [x] `doctor`'a soket yolu uzunluğu kontrolü ekle (`socket-path`, ilk host-scoped check).

#### Kabul kriterleri

- [x] Uzun yolda çıkan hata tek satırlık, anlaşılır ve eyleme dönük.
- [x] Hiçbir kullanıcı çıktısında `/Users/runner/...` görünmüyor.

---

### [x] 40. `daemon status` sabit launchd label yüzünden başka `HOME`'un agent'ını raporluyor

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

- [x] launchd label'ını `HOME`/workspace kökünden türetilen bir ayrımla üret
      (`dev.wtm.daemon.<HOME digest'i>`).
- [ ] ~~Ya da `daemon status` yüklü agent'ın program yolunu kendi yoluyla karşılaştırıp
      eşleşmiyorsa açıkça söylesin.~~ Bu alternatif kasıtlı olarak seçilmedi ve çalışmazdı:
      launchd servis adı `gui/<uid>/<label>` olduğu için sabit label'la iki `HOME` aynı anda
      bootstrap *edilemiyor* — tespit, ikinci `HOME`'u doğru teşhis edip yine kurulumsuz
      bırakırdı. Ayrıca karşılaştırılacak `program` bloğu 4 KiB'lik komut çıktısı saklama
      sınırının ötesine düşebiliyor.
- [x] `plistPath`'in raporlanan `state` ile aynı agent'a ait olduğunu doğrula; `status`
      artık label'ı da yayınlıyor.
- [x] Migration: eski sabit label'lı agent'ları tanı ve devral. Yalnızca plist'i *bu* `HOME`'a
      ait olan legacy servis bootout ediliyor; başka bir `HOME`'unkine dokunulmuyor. Label'dan
      türeyen journal/lock kardeş dosyaları da süpürülüyor.

#### Kabul kriterleri

- [x] İki farklı `HOME`'daki daemon birbirinin durumunu raporlamıyor.
- [x] `state`, `runState` ve `reachable` her zaman aynı agent'ı anlatıyor.

---

### [x] 41. `init` sonrası oluşturulan worktree reconcile olana kadar görünmez

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

- [x] Daemon erişilemezken kayıtsız bir worktree'de çalışan komutlar bunu ayrı bir tanı olarak
      raporlasın. `wtm env` artık `GIT_REPOSITORY_DEGRADED` değil `WTM_WORKSPACE_NOT_FOUND`
      (exit 2) veriyor.
- [x] Hata mesajı `wtm init` veya daemon başlatmayı önersin.
- [x] Daemon yokken CLI'ın tek seferlik reconciliation yapıp yapamayacağını değerlendir.
      Yapabiliyor: okuma komutları daemon erişilemezken *içinde bulunulan repository*'yi yerel
      olarak reconcile edip `WTM_DAEMON_UNAVAILABLE` uyarısıyla cevap veriyor.
- [x] Daemon ayağa kalktığında bekleyen worktree'leri otomatik reconcile et. Daemon zaten
      açılışta her kayıtlı repository'yi reconcile ediyordu; bu, kod yazılmadan önce
      characterization testiyle kanıtlandı (`reconcile-fallback` senaryosu, `daemon-returns`).
- [x] `doctor` "daemon erişilemez" ile "worktree kayıtlı değil" durumlarını ayırsın
      (yeni `registration` check'i; eskiden `adapters` altında `unknown` olarak yanlış yerdeydi).

#### Kabul kriterleri

- [x] Kullanıcı yeni worktree'sinin neden görünmediğini çıktıdan anlıyor.
- [x] Daemon geri geldiğinde manuel `init` gerekmiyor.

---

### [x] 42. Idle RSS bütçe hedefinin üzerinde

Idle daemon ölçümü 60 MiB hedefinin üzerinde, 80 MiB investigation eşiğinin altında:

```text
73.9 MiB
63.7 MiB
```

Test bunu `warning` olarak raporluyor, `blocker` değil — yani release'i durdurmuyor ama hedef
tutmuyor.

#### Yapılacaklar

- [x] RSS'i neyin tuttuğunu ölç (SQLite, structural watcher, embedded runtime). — `runtime-factory.ts`'i
      standalone bundle'a derleyip her başlatma adımında `process.memoryUsage().rss` ölçen bir
      breakdown (darwin arm64, bu makine): çıplak Node.js süreci tek başına **46 MiB**; bundle'ı
      (better-sqlite3 native binding dahil) import etmek **+27 MiB**; `createProductionDaemon()`
      (SQLite store + supervisor + log store kurulumu, henüz start yok) **+5 MiB**;
      `runtime.start()` (Unix socket server + structural watcher açılışı) **+0.3 MiB**. Yani
      toplam ~78 MiB'ın ~73 MiB'ı WTM'den önce gelen Node.js/native-binding tabanı; WTM'nin kendi
      daemon mantığı bu tabana yalnızca ~6 MiB ekliyor — sorun kod verimsizliği değil, hedefin
      gerçek taban maliyetin altında olması.
- [x] Hedefi tutturmak ile hedefi gerçekçi bir değere çekmek arasında karar ver. — Kullanıcıyla
      birlikte karar: hedefi gerçekçi sayıya çek. Gerekçe: 60 MiB, bu projenin sabitlenmiş Node.js
      sürümünde çıplak bir sürecin bile altında kalamayacağı bir sayıydı; WTM'nin kendi katkısı
      zaten yalnızca birkaç MiB.
- [x] Karar hedefi değiştirmekse `docs` ve `idle-daemon.scenario.ts` içindeki 60 MiB'ı birlikte
      güncelle. — Yeni eşikler **85 MiB pass / 110 MiB investigation** (`idle-daemon.scenario.ts`,
      `idle-daemon.test.ts`, `docs/05-daemon-and-macos-runtime.md`, `docs/14-testing-performance-
      security.md`), gerekçesiyle birlikte.
- [x] Ölçümü her iki mimaride de tekrarla. — arm64 bu oturumda 5 kez ölçüldü (76.28–76.53 MiB
      aralığı, kararlı); x64 için gerçek CI verisi zaten mevcuttu (`33333237513`, 2026-08-30:
      63.7 MiB) — yeniden koşmaya gerek kalmadı, yeni eşiklerin ikisini de rahatça karşılıyor.

#### Kabul kriterleri

- [x] Yayınlanan hedef ile ölçülen değer aynı hikâyeyi anlatıyor. — her iki mimarideki her gerçek
      ölçüm (CI ve local) artık 85 MiB pass eşiğinin altında.
- [x] Stable release'te RSS `pass` veriyor. — yerel doğrulama: `node --import tsx packages/daemon/
      src/__tests__/idle-daemon.scenario.ts` artık `"status":"pass"` veriyor (önceden `"warning"`).

**Çözüldü:** 2026-09-06, gerçek ölçümle taban maliyet tespit edilip hedef ona göre yeniden
kalibre edildi.

---

### [x] 43. Çok depolu workspace kökünde `resolve` ham `git` hatası basıyor

Increment B sırasında quick start testi yazılırken bulundu. README'nin açıkça desteklediği layout —
kendisi Git deposu olmayan, altında birden çok repo tutan bir workspace kökü — o kökte çalıştırılınca
`resolve` şu hatayı veriyor:

```text
[WTM_CONFIG_INVALID] Git worktree list in ... failed (exit 128): onulmaz: bir git deposu ... değil: .git
```

Üç ayrı kusur var: hata ham `git` stderr'i sızdırıyor; mesaj kullanıcının locale'ine göre değişiyor,
yani programatik olarak da okunamıyor, İngilizce de değil; ve `WTM_CONFIG_INVALID` yanlış kodu —
yapılandırmada bir sorun yok, kullanıcı yalnızca yanlış dizinde duruyor. `WTM_WORKSPACE_NOT_FOUND`
zaten var ve eyleme dönük bir mesaj taşıyor.

Bu 39. maddenin aynı sınıfı: kullanıcıya giden bir hata, alt katmanın ham çıktısını taşıyor.
39 daemon soketi için çözüldü, bu yol için çözülmedi.

#### Yapılacaklar

- [~] Workspace kökünün kendisi bir depo olmadığı durumu, `git` çağrılmadan önce tanı. —
      literal olarak değil: `git worktree list` hâlâ çağrılıyor, `workspaceRootNotRepositoryError`
      (`packages/cli/src/main.ts`) exit code 128'i sonradan yakalayıp çeviriyor. Kullanıcıya giden
      çıktı için sonuç aynı (hiçbir ham `git` metni sızmıyor), bu yüzden aşağıdaki kabul kriterleri
      karşılanıyor; bu madde yalnızca yaklaşımın "önce tanı" değil "yakala ve çevir" olduğunu not
      düşüyor.
- [x] `WTM_WORKSPACE_NOT_FOUND` ile, hangi depoya `cd` edileceğini söyleyen bir mesaj üret. —
      `discoverableRepositories` bulunan repoları listeliyor.
- [x] Kullanıcıya giden hiçbir mesajın locale'e bağlı `git` metni taşımadığını doğrulayan test ekle. —
      `production-commands.scenario.ts`'teki `multiRepoRootResolve`/`multiRepoRootRunWithoutRepositories`,
      mesajın `'fatal'` içermediğini ve `error.context`'te `stderr` olmadığını doğruluyor.
- [x] Aynı yolu `run`, `start` ve `env` için de kontrol et. — `run`, `resolve` ile aynı yolu
      (`unregisteredTaskResolution`) kullanıyor, aynı düzeltmeyi otomatik alıyor. `start` daemon'a
      `requestRuntimeCommand` ile gidiyor, `env` kayıtlı workspace'lere bakıyor — ikisi de
      kaydedilmemiş bir dizin için hiç `git` çağırmıyor, dolayısıyla bu kusura hiç maruz kalmıyorlardı.

#### Kabul kriterleri

- [x] Çok depolu kökte `resolve` ne yapılacağını söylüyor.
- [x] Hiçbir kullanıcı çıktısında çevrilmiş `git` hata metni görünmüyor.

**Çözüldü:** `b5395ae` — `WTM_WORKSPACE_NOT_FOUND` artık bulunan repoları listeleyerek üretiliyor.

---

### [x] 45. Soket olmayan bir IPC yolu daemon'ı süresiz crash döngüsünde bırakıyor

**2026-09-11:** Kapandı, `claude/item-45-daemon-crash-loop` üzerinde. Spec:
`docs/superpowers/specs/2026-09-09-daemon-startup-crash-loop.md`, plan:
`docs/superpowers/plans/2026-09-09-daemon-startup-crash-loop.md`. Commit'ler: `ee39fea`
(`WTM_IPC_PATH_UNUSABLE`, exit 2), `feb6045` (bayat close-shield placeholder'ı geri alma, diğer her
şeyi kodla reddetme), `104d9fc` (supervised daemon kalıcı hatada exit 0; tek restart politikası),
`45b12c5` (`daemon-status.json`, frame'lerin açılışlar arası tek kez yazılması), `d3f41ea` (daemon
loglarının rotation'ı), `3b496de` (`wtm doctor` sebebi söylüyor), `ce04b80` + `17bbde4`
(`wtm daemon install` başlamayan daemon'ı sebebiyle bildiriyor).

Kodu okuduktan sonra spec'e beş revizyon eklendi (spec'teki "Revisions after reading the code
(2026-09-11)" bölümü): R1 yalnızca bize ait, 0 bayt, `0600`, tek link ve en az 30 sn eski dosya geri
alınır; R2 kalıcı hatada exit 0 yalnızca `WTM_DAEMON_SUPERVISED=1` iken; R3 plist
`ThrottleInterval` 10, unit `RestartSec=10` + `StartLimitIntervalSec=0`; R4 frame tekilleştirmesi
`daemon-status.json` üzerinden; R5 doctor var olmayan `daemon start` yerine `wtm daemon install`
diyor.

Aşağıdaki "Yapılacaklar" kutusundaki "backoff" maddesi farklı bir tasarımla karşılandı: üstel geri
çekilme değil, kalıcı hatada durma, sabit 10 sn'lik tek bir yeniden deneme aralığı, ve frame'lerin
açılışlar arası tek kez yazılması. Açık kalan iki parça 51 (kodsuz ama kalıcı açılış hataları) ve
52 (`wtm doctor` kayıtlı workspace yokken) maddelerine taşındı; bu madde onları kapsamıyor.

Elle doğrulama, geçici bir `HOME` altında (`mktemp -d /tmp/wtm-item45-XXXX`, gerçek `~/Library`'ye
dokunmadan, `WTM_DAEMON_SUPERVISED=1 wtm daemon serve --json`):

- `.tmd.sock` yolunda 2026-09-02 tarihli 0 baytlık `0600` dosya: placeholder geri alındı, daemon
  ayağa kalktı, SIGTERM ile `{"ok":true,"data":{"state":"stopped","signal":"SIGTERM"}}` ve exit 0.
- `.tmd.sock` yolunda bir dizin: daemon exit 0 ile durdu, zarf `WTM_IPC_PATH_UNUSABLE`
  (`occupant: "directory"`, "WTM will not remove a directory. Move it aside, then run
  `wtm daemon install`.") taşıdı; `Library/Logs/WTM/daemon-status.json` `state: "failed"`,
  `permanent: true`, `attempts: 1` kaydetti.

2026-09-09'da, bu repodan temiz bir `make install` yapılırken bulundu. Kurulum başarılı raporladı,
ama daemon hiç ayağa kalkmadı ve bunu söyleyen bir çıktı yoktu.

`~/Library/Application Support/WTM/.tmd.sock` yolunda soket yerine 0 baytlık normal bir dosya
duruyordu (2026-09-02 tarihli; nasıl oluştuğu bilinmiyor — muhtemelen o gün koşan bir testin ya da
yarıda kalan bir daemon'ın artığı). Daemon her açılışta bağlanmayı reddetti, launchd her seferinde
yeniden başlattı, ve bu yedi gün boyunca sürdü.

#### Kanıt

```text
$ wtm daemon status
runState: spawn scheduled
reachable: false

$ launchctl print gui/$(id -u)/dev.wtm.daemon.<hash>
last exit code = 1

$ ls -la ~/Library/Application\ Support/WTM/.tmd.sock
-rw-------  1 furkan  staff          0 Sep  2 14:16 .tmd.sock

$ ls -la ~/Library/Logs/WTM/daemon.error.log
-rw-------  1 furkan  staff  162321745 Sep  9 11:38 daemon.error.log
```

162 MB, denemesi başına ~2.7 KB stack trace demek ~60.000 yeniden başlatma — launchd'nin 10 sn'lik
varsayılan `ThrottleInterval`'ı ile yedi güne tam oturuyor. Yani sayı tahmini değil, ölçülen
dosya boyutu ile takvim birbirini doğruluyor.

Kullanıcının gördüğü tek şey `reachable: false`. `wtm doctor` da `daemonReachable: false` diyor,
sebebini söylemiyor. Log 162 MB olduğu için okunması da kolay değil.

#### İki ayrı kusur

**1. Soket olmayan yol için kurtarma yolu yok.** `prepareSocketPath`
(`packages/platform/src/ipc/unix.ts:295-322`) bayat bir *soket* için eksiksiz bir kurtarma taşıyor:
sahiplik doğrulaması, canlılık probe'u, quarantine, unlink. Ama ilk kontrol `initial.isSocket()` ve
başarısızlığı koşulsuz `throw`. Yolda normal bir dosya varsa hiçbir kurtarma denenmiyor. Mesaj da
eyleme dönük değil: dosyanın silinebileceğini söylemiyor, bir komut önermiyor, stable bir error code
taşımıyor. 39. ve 43. maddelerin sınıfı burada tekrar ediyor — doğru teşhis edilmiş bir durum,
kullanıcıya ne yapacağını söylemeyen bir mesajla bildiriliyor.

**2. Kalıcı açılış hatası geçici hata gibi ele alınıyor.** `packages/platform/src/service/darwin.ts:167`
`KeepAlive{SuccessfulExit:false}` yazıyor ve `ThrottleInterval` vermiyor; stderr doğrudan
`daemon.error.log`'a bağlı (`service-lifecycle.ts:336`), rotation yok, üst sınır yok. Her deneme tam
stack trace basıyor. `linux.ts:173`'teki `Restart=on-failure` aynı yapı, dolayısıyla aynı davranış.
Sonuç: hiç açılamayan bir daemon, kullanıcı fark etmeden diski dolduran bir log üretiyor. Managed
task logları için rotation var; daemon'ın kendi stderr'i için yok.

Ayrıca aynı logda, diskte olmayan kayıtlı depolar için de her turda birer stack trace basılıyor
(`missingDirectory`). Bunlar ölümcül değil ve mesajları doğru, ama uyarı seviyesinde bir durum
tam stack trace ile yazıldığı için log hacmini büyütüyorlar.

#### Yapılacaklar

- [x] Soket olmayan bir IPC yolunu, aynı sahiplik/identity doğrulamasından geçirdikten sonra bayat
      soketle aynı quarantine yolundan geçir. Fail-closed kalması gereken durumları (başkasına ait,
      dizin, symlink) ayır ve gerekçesini yaz.
- [x] Reddedilen her durum için eyleme dönük mesaj ve stable JSON error code üret: hangi yol, neden
      reddedildi, kullanıcı ne yapmalı.
- [x] `wtm doctor`, daemon `reachable: false` olduğunda sebebini raporlasın. Bugün ulaşılamadığını
      biliyor, nedenini bilmiyor — oysa neden daemon'ın kendi log'unda yazılı.
- [x] Daemon'ın kendi stderr'ine rotation ve üst sınır ekle.
- [x] Tekrarlayan açılış hatasına backoff ver; aynı hata üst üste tekrarlıyorsa tam stack trace'i
      her turda yeniden basma.
- [x] Diskte olmayan kayıtlı depoları stack trace ile değil, tek satırlık uyarı ile bildir.
- [x] Regresyon testi: IPC yolunda normal bir dosya varken daemon'ın davranışını sabitle.

#### Kabul kriterleri

- [x] IPC yolunda soket olmayan bir dosya varken daemon ya kendiliğinden toparlanıyor ya da ne
      yapılacağını söyleyen tek bir hata veriyor.
- [x] Hiçbir açılış hatası sınırsız log büyümesi üretmiyor.
- [x] `wtm doctor` ulaşılamayan bir daemon'ın sebebini söylüyor.
- [x] Yeni kurulum yapan kullanıcı, daemon ayağa kalkmadığında bunu kurulum çıktısından anlıyor.

---

### [x] 51. Kodsuz ama kalıcı açılış hataları hâlâ yeniden başlatma döngüsüne giriyor

45. maddenin final review'ında bulundu (I3). `PrivateDirectoryError` (`WTM_PRIVATE_DIRECTORY_UNSAFE`,
kayıtlı bir `WtmErrorCode` değil) ve `unix.ts`'teki `secureSocketParent`'ın iki reddi kodsuz kaldığı
için `codedError` bunları tanımıyor, exit 1 ile bitiyor, ve supervised bir daemon bunları 10 sn'de
bir sonsuza kadar deniyor. Linux'ta durum daha kötü: 45. maddenin R3'ü kaldırdığı
`StartLimitIntervalSec=0` sınırı olmadan, dağıtımın varsayılan start limiti artık bu sınıfı
durdurmuyor — sembolik bağlanmış bir `~/Library/Application Support/WTM` (bazı kullanıcılar bunu
yapıyor) tam bu döngüye giriyor.

Ayrıca M9: elle çalıştırılan `wtm daemon serve`, soket zaten kullanımdaysa ("already in use")
başarısız olur ve bunu `daemon-status.json`'a yazar. Servis daemon'ı sonra çökerse, `wtm doctor`
"already in use" sebebini gösterir — oysa bu, kaydı yazan elle yapılan denemenin sebebidir.

#### Yapılacaklar

- [x] `PrivateDirectoryError`'ı yalnızca mod/sahiplik/symlink dallarında sınıf 2'ye kaydet, `chmod
      700 <path>` remediation'ı ile; ENOENT olmayan `lstat` hatasını (EIO/EACCES, muhtemelen
      geçici) kodsuz bırak.
- [x] `secureSocketParent`'ın aynı iki sahiplik/tip reddine aynı muameleyi uygula.
- [x] Linux için `StartLimitBurst`'ün bu sınıfa karşı bir yedek olarak tutulup tutulmayacağına karar
      ver.
- [x] Elle çalıştırılan `wtm daemon serve`'in "already in use" reddi çalışan servisin
      `daemon-status.json` kaydını ezmesin (M9): ya bu red için `recordOutcome`'u atla, ya da
      `wtm doctor` `pid`'i karşılaştırsın.

#### Kabul kriterleri

- [x] `WTM_PRIVATE_DIRECTORY_UNSAFE` mod/sahiplik/symlink dallarında sınıf 2, supervised iken exit
      0.
- [x] Aynı hatanın ENOENT olmayan `lstat` dalı kodsuz ve geçici kalıyor.
- [x] `secureSocketParent`'ın iki reddi aynı sınıfta.
- [x] Elle koşan bir `serve`'in "already in use" reddi, çalışan servisin kaydını ezmiyor.

#### Not (2026-09-11)

Kapandı, branch `claude/item-51-uncoded-permanent-failures`.

- **Kod:** `WTM_PRIVATE_DIRECTORY_UNSAFE` protokole kaydedildi (exit 2).
- **Kalıcı dallar:** `PrivateDirectoryError` bu kodu yalnızca dört dalda taşıyor: symlink, dizin
  değil, başka kullanıcının, başkalarınca okunabilir. Yalnızca sonuncusuna `chmod 700 <path>`
  remediation'ı eklendi. `@wtm/core` işletim sistemini bilmediği için bu öneri, mesajın zaten her
  platformda söylediği "run chmod 700 on it" kadar platformdan bağımsız.
- **Geçici dallar:** okunamayan, açılamayan ya da kontrol sırasında değişen dizin
  (`replaced` senaryosu dahil) kayıtsız `WTM_PRIVATE_DIRECTORY_UNAVAILABLE` taşıyor. Kodsuz
  kalıyor, yani yeniden deneniyor.
- **`secureSocketParent`:** symlink, dizin değil ve başka kullanıcının dalları platform'daki
  `SocketDirectoryUnsafeError` ile aynı kodu taşıyor. `@wtm/platform`, `@wtm/core`'u import
  edemediği için sınıf ayrı.
- **Yol üzerindeki dosya:** yolda bir dosya ya da kırık bir link varsa `mkdir`'in EEXIST'i artık
  yutuluyor, sınıflandırmayı `lstat` yapıyor.
- **M9:** "already in use" reddi artık kendi sınıfında (`IpcSocketInUseError`, kodsuz).
  `serveDaemon` bu red için `recordOutcome`'u atlıyor; red yine log'a gidiyor.

**Karar, `StartLimitBurst`: eklenmedi.** Gerekçeler:

- launchd'de karşılığı yok.
- Tanınan bütün kalıcı hatalar artık exit 0 ile duruyor.
- Start limitine takılan bir unit `failed`'da kalır. `reset-failed` yapılana kadar `systemctl
  --user start` bile onu reddeder. Bu, geç mount edilen bir HOME gibi geçici bir hatayı tam da
  R3'ün önlemek istediği kesintiye çevirirdi.
- Tanınmayan kalıcı bir hatanın bedeli 10 sn'de bir uyanmak; loglar sınırlı.
- Gerekçe `linux.ts`'teki unit yorumunda.

**Yerinde kalan davranış:** `wtm init` kendi eşlemesiyle bu hatayı hâlâ `WTM_CONFIG_INVALID`
olarak raporluyor. Bu değişmedi, kapsam dışı.

**Final review'dan (opus):**

- **I1, düzeltildi.** Hedef dizin henüz yoksa kod, var olan en yakın üst dizine kadar çıkıyor. Bu
  üst dizin başka kullanıcınınsa, örneğin henüz mount edilmemiş bir HOME'un root'a ait `/home`'u ya
  da `/Volumes/<disk>`, hata ilk sürümde kalıcı sayılıp daemon'ı durduruyordu. Artık geçici
  sayılıyor ve yeniden deneniyor. Başka kullanıcıya ait *hedef* dizin kalıcı kalıyor.
- **M1, düzeltildi.** Node'da kırık link üzerinde `mkdir` ENOENT veriyor; artık o da `lstat`'a
  bırakılıyor.
- **M4, düzeltildi.** Geçici hataların mesajı artık "unsafe" değil "unavailable" diyor.
- **M6, düzeltildi.** docs/18 artık grup/diğer izin bitlerinin hepsini sayıyor.
- **M5, kısmen.** I1 ve kırık link için testler eklendi.
- **Açık kalan:** M2 (`ENOTDIR`/`ELOOP` kodsuz) ve M3 (Windows'ta ACL okuma hatasının kalıcı
  sayılması). Windows daemon'ı dağıtılmadan önce M3 ele alınmalı.

**Doğrulama (throwaway HOME'da, supervised `daemon serve`):**

- (A) `~/Library` 755: exit 0, `WTM_PRIVATE_DIRECTORY_UNSAFE`, `chmod 700` önerisi,
  `permanent:true`.
- (B) Veri dizini symlink: exit 0, aynı kod.
- (C) Servis ayaktayken elle `serve`: exit 1, "already in use". `daemon-status.json` ilk daemon'ın
  `running` kaydını ve pid'ini koruyor.

---

### [ ] 52. `wtm doctor`, kayıtlı workspace yokken daemon'ın neden kalkmadığını söylemiyor

45. maddenin final review'ında bulundu (T8). Kayıtlı hiçbir workspace yokken `collect()` herhangi
bir veri kaynağı çalışmadan `WTM_NOT_INITIALIZED` ile duruyor; dolayısıyla hiç `wtm init`
çalıştırmamış taze bir kurulumda `wtm doctor` daemon'ın neden ayakta olmadığını söylemiyor.
`wtm daemon install` bunu zaten bildiriyor, bu yüzden öncelik düşük.

#### Yapılacaklar

- [ ] Kayıtlı workspace olmayan bir makinede de `daemon-status.json`'ı okuyup nedeni yüzeye
      çıkaran bir kontrol ekle; `WTM_NOT_INITIALIZED` erken dönüşü bunun önüne geçmesin.

#### Kabul kriterleri

- [ ] Hiç `wtm init` çalıştırılmamış bir makinede `wtm doctor`, daemon kayıtlı bir başarısızlıkla
      duruyorsa bunu ve nedenini raporluyor.

---

## P1 — V1 deneyimini tamamlayacak işler

### [ ] 50. AI oturumları için ortak ağır iş kuyruğu ve RAM bütçesi

> **Numara notu (2026-09-11):** Bu madde ayrı bir branch'te 45 olarak açıldı; aynı gün main'de
> 45 numarası daemon crash döngüsüne verildi. Birleştirmede bu madde 50'ye taşındı. 2026-09-09 ve
> 2026-09-10 tarihli commit mesajlarında geçen "45" bu maddeyi kastediyor.

**2026-09-09 kullanıcı ihtiyacı:** Birden fazla Claude/AI oturumu kullanıldığında yüksek RAM
tüketimi gözleniyor. Araştırılacak çözüm, eşzamanlı build/test/typecheck yükünü sınırlamak:
skill ağır komutları WTM'ye göndermeli; WTM bunları ortak bir kuyruğa alırken AI bağımsız
işlerine devam edebilmeli. Belleğin ne kadarının bu alt süreçlerden geldiği henüz ölçülmedi.

**Durum: sabit eşzamanlılık dilimi uygulandı; Linux ve iki macOS mimarisinde native kanıt alındı.**
Windows doğrulaması açık. 2026-09-10 RAM kabulünün bağımsız review’u tamamlandı;
bütçe açık gerçek worker CI senaryosu eklendi, native sonucu ve gerçek iki AI ölçümü açık.
Migration 012, daemon scheduler, CLI/IPC ve skill birlikte eklendi. `wtm run` foreground
davranışı korundu; `--enqueue` kalıcı kabulden sonra döner. `wtm start` servisleri bu slotu
kullanmaz. Bu bir RAM kotası değildir. Ayrıntılar ve doğrulama sınırları:
`docs/development/2026-09-09-todo-analysis.md`; tekrarlanabilir gerçek makine ölçümü:
`docs/development/2026-09-09-heavy-job-memory-measurement.md`.

#### Kapsam ve ilk dilim

- [ ] Önce temsili iki oturumda süreç ağacını ölç; Claude'un kendi belleği, ağır komutlar ve
      uzun ömürlü servislerin payını ayır. Kuyruğun hedeflediği yükü bu başlangıç ölçümüyle doğrula.
- [x] Aynı host ve işletim sistemi kullanıcısının WTM oturumları, repository/worktree'den
      bağımsız ortak ağır iş kotasını paylaşsın. Paylaşılan `HOME` farklı host'ların RAM
      bütçelerini birleştirmesin. Ayrı state diziniyle kota aşmanın kapsamı açıkça belgelensin.
- [x] İlk dilimde ayarlanabilir `max_concurrent_heavy = 1` ile ağır işleri sırala.
      Hafif okuma/inceleme işleri bu kuyruğa girmek zorunda olmasın. İlk destek config'te
      tanımlı, sonlanan task'lar için olsun; mevcut foreground `wtm run` davranışı korunsun.
- [x] CLI, iş kalıcı olarak kabul edilince `jobId` ve ilk kabulde `QUEUED` durumu döndürüp çıksın.
      Kabul yanıtı işin başarılı olduğu anlamına gelmesin; CLI kapansa da daemon işi yönetsin.
      Aynı anahtarla tekrar sorgu mevcut durumu döndürür; kabul öncesi sınırlı kaynak kontrolü yapılır.
- [x] Mevcut daemon ve SQLite state üzerinde kalıcı FIFO kuyruk kur. İş alma ve slot ayırma
      atomik olsun; birden fazla CLI aynı işi veya aynı slotu eşzamanlı çalıştıramasın.
      Ek kuyruk servisi gerektirmesin; kuyruk boyutu, log ve sonuç saklama süresi sınırlı olsun.
- [x] İş kimliği, repository/worktree, komut fingerprint'i, başlama/bitiş zamanı, exit code,
      signal, iptal nedeni ve `jobId` üzerinden log sorgusu sunulsun. JSON zarfı sürüm 1;
      config/env içindeki sırlar durum çıktısına veya metadata'ya açık olarak taşınmasın.
      Karar: çözümlenen argv/env sır içerebilir; yalnızca fingerprint saklanır. Task logları sır içerebilir.
- [x] Tekrar gönderim için açık idempotency anahtarı destekle. Aynı task adına ait farklı
      talepleri kendiliğinden birleştirme. Durumlar `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`,
      `CANCELLED`, `TIMED_OUT`, `INTERRUPTED` olarak açıkça ayrışsın.
- [x] İptal/timeout bütün süreç ağacını mevcut process identity kontrolleriyle sonlandırsın;
      slot ancak süreçlerin durduğu doğrulanınca serbest kalsın. Daemon yeniden başladığında
      kimliği doğrulanmış çalışan işi uzlaştırsın; sonucu belirsiz işi otomatik tekrar çalıştırmasın.
- [x] Kuyruktaki iş ile `remove`/cleanup yarışı mevcut lease ve runtime güvenlik zincirine
      bağlansın. Silinen/değişen worktree'ye iş başlatılmasın; pending ve running işler
      removal sırasında açıkça ele alınsın. Aynı worktree'de çakışan işler eşzamanlı başlamasın.

İptal/timeout/restart ve downtime completion senaryoları `dbf7734` için Linux x64, macOS ARM64
ve macOS x64 native runner'larında geçti; PID/grup incelemesi ve gerçek descendant yokluğu
doğrulandı. Bu kriter mevcut macOS/Linux kapsamı için kapandı; Windows native kanıtı açık.
İlk eski-state geçişi mevcut host-local varsayımını devralır; legacy kayıtların host kimliği
geriye dönük kanıtlanamaz.

#### Uygulanan CLI ve agent skill akışı

```bash
wtm run typecheck --enqueue --json
wtm jobs list --json
wtm jobs status <job-id> --json
wtm jobs logs <job-id> --tail 100
wtm jobs result <job-id> --json
wtm jobs cancel <job-id>
```

- [x] Skill: ağır işi gönder → `jobId` sakla → bağımsız işe devam et → gerektiğinde durum/log/
      sonuç sorgula. Sık polling yapma; gerçekten bağımlı adımda sınırlı bekleme politikası kullan.
      Son durum ve exit code okunmadan test/build başarılı deme veya buna dayanarak commit yapma.
- [x] Sonucun hangi kaynak durumuna ait olduğunu takip et. İlk dilimde agent, queued/running
      işin okuduğu worktree dosyalarını değiştirmesin; kod okuyabilir, planlayabilir veya başka
      worktree'de çalışabilir. Başka oturumun dosya değişiklikleri sonucu geçersiz kılabilsin;
      yalnızca HEAD eşitliğini doğrulama kanıtı sayma, commit edilmemiş değişiklikleri de ele al.
- [x] Dağıtılan WTM skill'ini Claude/Codex için bu akışla genişlet.
      Skill yalnızca WTM üzerinden gönderilen işleri sıraya sokar; doğrudan çalıştırılan bütün
      komutları zorla yakaladığı veya AI'ı kendiliğinden yeniden uyandırdığı iddia edilmesin.
      Otomatik bildirim/hook entegrasyonu ayrı, desteklenen agent yeteneklerine bağlı bir dilim olsun.
      Kullanıcının gerçek oturumlarına kurulum ve iki agent ile deneme henüz doğrulanmadı.
      Kaynak kanıtı tracked/untracked içerik, index/HEAD ve metadata ile sınırlı; ignored/external
      girdileri veya atomik filesystem snapshot'ını kapsamaz, geçici oluştur/sil değişikliği kaçabilir.

#### RAM farkındalığı: ikinci dilim

**2026-09-10 uygulaması:** Global `jobs.memory` budget/headroom ve task `memory_estimate_mib`
ile tahmine dayalı kabul; `queue_env` task worker ayarlarını yalnız queued execution'a uygular.
Migration 013 tahmini saklar; SQLite transaction tüm held tahminleri aynı claim'de sayar.
Node available/constrained memory kullanılır, süreç ağacı/RSS taraması eklenmez. İmkânsız veya
eski tahminsiz queued işler açık hatayla sonlanır; held işler cleanup kanıtına kadar rezervasyon
korur. Geçici yetersizlikte strict FIFO bekler. Native ve gerçek makine ölçümü hâlâ açık;
`docs/development/2026-09-10-todo-continuation.md` test ve review sınırlarını kaydeder.

- [x] Sabit eşzamanlılık sınırından sonra, task bellek tahmini ve host'un kullanılabilir
      belleği/bellek baskısıyla yeni iş kabulünü değerlendir. İşletim sistemi, Claude/AI ve diğer
      uygulamalar için pay bırak. Tek build'in kendi worker paralelliği için task'a özel ayar
      sun; yalnızca kuyruk uzunluğunu azaltmayı kesin bir RAM üst sınırı gibi sunma.
- [x] Uygulanan sabit sınırın bekleme nedenlerini list/status/result/cancel içinde görünür yap:
      `concurrency`, `worktree_busy`, `fifo`, `dispatch_pending`. Tanı ve atomik claim aynı
      FIFO/slot kararını kullanır; sorgu state'i değiştirmez. Bu gözlem slot rezervasyonu değildir.
- [x] RAM kabul kontrolüyle birlikte `memory_budget` nedenini ekle. Bütçeye hiçbir zaman
      sığmayacak talebi açıkça reddet; kuyruğun sessizce tıkanmasını önle. Bellek yüzünden
      bekleyen işlerin ilerleme ve adalet politikasını tanımla.
- [x] Uzun ömürlü `wtm start` servislerini sonlanan ağır işlerden ayrı ele al; dev server
      tek ağır iş slotunu süresiz tutmasın, fakat belleği kabul hesabında dikkate alınsın.
- [ ] Süreç ağacının bellek ölçüm maliyetini sınırla. RSS toplamını paylaşılan sayfalar nedeniyle
      kesin fiziksel RAM tüketimi sayma. Tahmine dayalı kabul kontrolü ile işletim sistemi
      tarafından zorlanan sert bellek sınırını ayır; platform desteğini doğrulamadan vaat etme.
      Genel disk/process bütçeleri madde 19'da kalsın; iki ayrı scheduler oluşturma.

#### Kabul kriterleri

- [ ] İki AI oturumu farklı repolardan aynı anda ağır iş gönderdiğinde, limit 1 ise en fazla
      bir ağır iş çalışır; diğer iş kuyrukta kalır, her iki gönderim de beklemeden `jobId` döndürür.
- [x] FIFO sırası, eşzamanlı gönderim, idempotent tekrar, dolu kuyruk ve daemon restart testli.
      Yeniden başlatma veya kimlik belirsizliği aynı komutu ikinci kez başlatmaz.
      SQLite eşzamanlılığı gerçek Node süreçlerinde; restart/scheduler kontrollü supervisor ile
      doğrulandı. Gerçek iki CLI/iki repo/tek slot, sonuç/log ve native iptal/timeout/restart/
      downtime completion senaryoları Linux x64 ve iki macOS mimarisinde geçti (`dbf7734`).
      Windows ve kullanıcının gerçek iki AI oturumu deneyi açık.
- [ ] Başarısız işin exit code'u ve log'u korunur; iptal, timeout ve süreç ağacı cleanup'ı
      slot sızdırmaz. Kuyrukta bekleyen iş worktree silme güvenliğini aşamaz.
- [ ] İşin kaynakları değiştiğinde eski sonuç güncel doğrulama gibi sunulmaz. Skill'in
      gönderme/devam etme/sonuç okuma akışı gerçek iki oturumlu senaryoyla doğrulanır.
- [ ] Aynı görev setiyle kuyruk öncesi/sonrası tepe bellek, bellek baskısı/swap, toplam süre
      ve WTM daemon ek maliyeti ölçülür. Claude'un kendi bellek tüketimindeki değişim ayrıca
      ayrıştırılır; ölçüm yapılmadan belirli bir RAM tasarrufu oranı vaat edilmez.

---

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

**Kısmen kapandı.** Tek repo `wtm create` çalışıyor; multi-repo, veri modelinde olmayan bir kavram
gerektirdiği için gerekçesiyle açık bırakıldı. Spec
`docs/superpowers/specs/2026-09-07-create-worktree.md`, plan
`docs/superpowers/plans/2026-09-07-create-worktree.md`. Başlık, multi-repo satırları açık olduğu
için madde 2 ve 7'nin kullandığı aynı kuralla `[ ]` kalıyor.

Dokuz alt maddenin üçü zaten yazılmıştı — `create`'in işi onları kurmak değil, tetiklemek: worktree
var olduktan sonrasının tamamı daemon'da. Bu, uygulamayı yazmadan önce spec'i yazmanın kazandırdığı
şeydi.

#### Yapılacaklar

- [x] Branch var/yok kontrolü. — `branchExists` (`git show-ref --verify`, exit 1 "hayır" cevabı
      olarak kabul ediliyor). Var olan dal *yeniden yaratılmıyor*, checkout ediliyor:
      "an existing branch is checked out rather than restarted somewhere".
- [x] Existing worktree conflict kontrolü. — iki ayrı ret, ikisi de Git hiçbir şey yazmadan önce:
      `GIT_BRANCH_IN_USE` (dalı tutan worktree'yi adıyla söylüyor) ve
      `WTM_WORKTREE_PATH_OCCUPIED`. Her testi kodun yanı sıra **hiçbir şey yaratılmadığını** da
      doğruluyor — bir reddin taşıyıcı yarısı bu.
- [x] Target path strategy. — `<workspace>/<repo-dizini>-<branch-slug>`. Kodda hiçbir konvansiyon
      yoktu; repository'nin içine hiçbir şey yazmayan, `wtm init`'in mevcut keşfinin zaten
      bulduğu ve deponun kendi senaryosunun (`reconcile-fallback.scenario.ts`) kurduğu düzen
      seçildi. Slug çakışması (`feat/auth` ve `feat-auth`) üretilmiş bir sonek yerine
      occupied-path reddiyle karşılanıyor: hesaplanmış bir yol ancak tahmin edilebildiği sürece
      işe yarar.
- [ ] Multi-repo branch alignment. — **açık.** Runtime bugün workspace + tam branch ref ile
      feature gruplaması yapıyor; eksik olan kalıcı feature kimliği ve creation journal'ı.
      `--repos` henüz kayıtlı CLI değildir. Ayrı repository başlangıç commit'leri önceden
      sabitlenmeli; aynı branch adı aynı commit OID'si anlamına gelmez.
- [x] Worktree oluşturulduktan sonra reconcile. — daemon ayaktaysa `reconcile` isteği (daemon
      cevaplamadan önce kuyruğunu boşaltıyor, yani cevap geldiğinde iş bitmiş oluyor); değilse
      CLI kendi reconcile ediyor. **Asla ikisi birden** — bir registry'nin iki yazıcısı olması
      `reconcileContainingRepository`'nin zaten önlediği hata.
- [x] Eager/lazy resource prepare policy ile uyum. — `prepareDiscovered` bunu zaten yapıyor;
      `create` daemon'a devrederek ona ulaşıyor. Daemon kapalıyken **çalışmıyor**, ve bu
      sessizce geçilmiyor: `WTM_DAEMON_UNAVAILABLE` uyarısı neyin atlandığını adıyla söylüyor.
- [x] `worktree.created` event entegrasyonu. — `LifecycleEventDispatcher.onReconciled` bunu zaten
      atıyor. CLI'ya ikinci bir dispatcher konmadı: bir event'in duyurulup duyurulmadığına iki
      yazıcının karar vermesi tam olarak `claimLifecycleEvent`'in önlemek için var olduğu şey.
- [x] `--json` stable output. — `registration: 'daemon' | 'local'` alanı dahil, ki `--json`
      çağıranı hook'ların çalışıp çalışmadığını daemon'u yoklamadan bilebilsin.
- [ ] Partial multi-repo creation rollback/recovery. — **açık.** Tek `git worktree add` bile
      CLI crash sonrası yaşayan Git/hook çocuğu veya kısmi yazma bırakabilir. Kalıcı üye
      aşamaları ve create lease migration'ı gerekir; belirsiz APPLYING aşaması otomatik
      tekrar çalıştırılamaz. Mevcut lease beklemek yerine çakışmayı reddeder; deterministik
      edinme sırası ve bütün repository'ler için mutasyon öncesi edinme yine gereklidir.

#### Kabul kriterleri

- [x] Tek repo create deterministic. — hesaplanmış yol, çağıranın dizininden bağımsız başlangıç
      noktası, ve Git yazmadan önce verilen her ret. Yeni dal **main worktree'nin HEAD'inden**
      başlıyor, kullanıcının içinde durduğu worktree'den değil: "starts a new branch at the main
      worktree HEAD" hem core hem CLI seviyesinde bunu doğruluyor.
- [ ] Multi-repo create aynı feature identity altında çalışıyor. — **bu dalganın kapsamı dışında.**
      Adını verdiği kimlik veri modelinde yok (yukarıya bakınız).
- [ ] Yarım kalan creation güvenli biçimde recover ediliyor. — **bu dalganın kapsamı dışında.**
      Tek repository'lik create'te kurtarılacak yarım bir durum yok.

---

### [x] 7. Gerçek cleanup candidate ranking ekle

`wtm analyze --cleanup-candidates` yalnızca linked worktree filtresi olmamalı.

**2026-09-10:** Sekiz girdi uygulandı. Yeni disk ölçümü bütün mevcut safety/activity tier'larından
sonra eşitliği bozar. Eksik ölçüm sıfır değildir; maliyet bütün adaylar için sınırlıdır ve
ölçüm silme yetkisi vermez. Dosya/ranking/CLI testleri ve bağımsız review tamamlandı.
Review’daki aynı-device mount bulgusu Linux platform reader’ı ve iki sınırlı snapshot ile
giderildi; core platform bağımsızlığı korundu. Native mount/unmount ve diğer platformlarda
aynı-device mount dışlama garantisi yok. Önceki ranking davranışı yeniden yazılmadı.

#### Ranking girdileri

- [x] deletion readiness — 1. tier. `safety.readiness`: SAFE → REVIEW → BLOCKED.
      `cleanup-ranking.test.ts`, "ranks SAFE above REVIEW above BLOCKED".
- [x] age — 6. tier. `readGitCommitTimestamp` (yeni, `git/git-runner.ts`) her aday için HEAD'in
      commit tarihini repository üzerinden okuyor — worktree dizini silinmiş bir adayın da
      tarihlenebilmesi için. Cevap alınamazsa `last-commit-unknown`.
- [x] merged/reachable state — 3. tier, `base.merged`.
- [x] remote persistence — 3. ve 4. tier. 4. tier `remoteKnowledge.source` ile nitelendiriyor:
      yalnızca yerel ref'lerden bilinen kalıcılık, fetch ile doğrulanmışın altında sıralanıyor.
      "persistence known only from local refs ranks below the same candidate after a fetch".
- [x] reclaimable disk size — `cleanup.reclaimable`, tek hard link'li normal dosyaların
      allocated block tahminidir. Git metadata, symlink/hedefleri, farklı device ve retained resource
      yolları sayılmaz; Linux ayrıca aynı-device descendant mount sınırlarını okur. Bütün adaylar toplam 2 saniye/20.000 entry bütçesini paylaşır;
      partial/unavailable değerler null kalır. COW/snapshot sebebiyle gerçek boşalacak bayt
      veya alt sınır garantisi değildir. Kaynak değişikliği ve path yarışı ölçümü geçersiz kılar.
      `wtm disk` ayrı resource-footprint sözleşmesini korur.
- [x] last WTM activity — 5. tier, ama beklenen alandan değil: `worktrees.last_runtime_at`
      sütununu **hiçbir production yolu yazmıyor**, migration'dan beri hep NULL. Bu yüzden aktivite
      managed-process journal'ından türetiliyor (`startedAt`/`stoppedAt`'in en yenisi), o da yoksa
      taban `createdAt` — "WTM bu worktree'yi şu tarihten beri tanıyor ve o zamandan beri içinde
      bir şey olduğunu kaydetmedi" ölçülmüş bir boşta kalmadır, bilgi yokluğu değil. Kayıt hiç
      yoksa `wtm-activity-unknown`.
- [x] running process var/yok — 2. tier. `listManagedProcesses` + `STARTING|RUNNING|STOPPING`.
      Bilinmiyor, "yok" ile aynı şey değil ve öyle sıralanmıyor: "not knowing whether anything is
      running ranks between provably idle and provably busy".
- [x] prunable state — 7. tier, `identity.prunableReason` ve `identity.pathExists`.

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

- [x] Çıktı deterministic. — sıra tam: her tier eşitse worktree yolu ile bozuluyor. "candidates
      identical on every tier come back in path order" ve "shuffling the input does not change the
      order" (girdi iki kez karıştırılıp aynı diziyi veriyor).
- [x] Ranking hiçbir zaman otomatik delete yapmıyor. — `analyze` salt-okunur kaldı, apply yolu ya
      da flag eklenmedi, ve `BLOCKED` aday listeden düşürülmüyor: en sona, blocker'larıyla
      birlikte konuyor. Onu gizlemek, sıralama kılığına girmiş bir politika kararı olurdu.
      `cleanup-ranking.test.ts` (CLI), "a candidate the safety analysis refuses to delete is ranked
      last, never filtered out".
- [x] Human ve JSON output aynı candidate sırasını kullanıyor. — sıralama renderer'da değil
      **zarfın içinde** yapılıyor; `renderEnvelope`, `--json`'ın serialize ettiği aynı
      `envelope.data`'yı geziyor, dolayısıyla ikisinin sıra konusunda anlaşmazlığa düşmesi yapısal
      olarak mümkün değil. Yine de varsayılmadı, uçtan uca ölçüldü: "the human rendering lists
      candidates in the same order as --json" insan çıktısındaki yol offset'lerinin artan olduğunu
      doğruluyor.

#### Score

`score` (0-100) sıralanan şey **değil**: sortun karşılaştırdığı aynı tier değerlerinden, sabit bir
fonksiyonla türetiliyor. Tier değerleri karışık tabanlı bir sayının basamakları olarak okunuyor, bu
yüzden bir aday kendisinden üstte sıralanan bir adaydan yüksek puan alamaz — eşitlik mümkün
(idleness puanda kovalanmış, sortta tam), anlaşmazlık değil. "score never disagrees with rank".

---

### [x] 8. Allowed remote refs configuration ekle

Core desteği kullanıcı config katmanına bağlanmalı.

**Kapandı.** Kodun tamamı zaten yazılmış ve testliymiş; bu madde geride kalan tek gerçek boşluk
olan kullanıcı dokümantasyonu kapatılarak bitirildi. Aşağıdaki her satır çalıştırılıp doğrulandı
(`allowed-remote-refs-config.test.ts` + `decisions.test.ts` + `schema.test.ts`: 23 test yeşil).

#### Önerilen config

```toml
[git]
allowed_remote_refs = [
  "refs/remotes/origin/*",
  "refs/remotes/upstream/*"
]
```

#### Yapılacaklar

- [x] Schema ekle. — `packages/core/src/config/schema.ts`'te `gitSchema`, `.strict()`; varsayılan
      `builtInConfig` içinde adıyla duruyor (`config/load.ts`), böylece `wtm explain`'in
      raporlayacağı bir "WTM'nin kendi varsayılanı" var: `["refs/remotes/origin/*"]`.
- [x] Config validation ekle. — aynı şemadaki `superRefine`, analiz anındaki kuralın *aynısını*
      (`normalizeAllowedRemoteRefs`, `analysis/remote-persistence.ts`) config yükleme anında
      çalıştırıyor. Yani `analyzeRemotePersistence`'ın derinlerinde çıplak bir `TypeError` olarak
      patlayacak bir pattern, bunun yerine hatalı pattern'i adıyla söyleyen kodlu bir
      `WTM_CONFIG_INVALID` olarak raporlanıyor.
- [x] Provenance desteği ekle. — `config/provenance.ts`'in `collectProvenance`'ı ve
      `config/merge.ts`'in katman birleştirmesi bu anahtarı da taşıyor; kazanan değerin dosyası ve
      satırı `decisions.test.ts`'te birebir doğrulanıyor
      (`{ source: '/projects/demo/wtm.toml', line: 60 }`).
- [x] `analyze` ve `remove` resolved config'i kullansın. — `packages/cli/src/main.ts`'te
      `resolveConfiguredAllowedRemoteRefs`; `analyze` repo başına tekilleştirip çözüyor, `remove`
      kendi repo'su için çözüp `commands/remove.ts`'e geçiriyor. İkisi de WTM'nin hiç kaydetmediği
      bir repository için de çalışıyor: workspace kökü kayıt aranarak değil, yukarı yürünerek
      bulunuyor.
- [x] Invalid wildcard pattern testleri ekle. — `packages/core/src/config/__tests__/schema.test.ts`
      (refs/remotes dışı, trailing olmayan wildcard, boş liste, kodlu hata) ve
      `packages/cli/src/__tests__/allowed-remote-refs-config.test.ts` (geçersiz pattern `analyze`'ı
      *crash* değil kodlu hata ile düşürüyor; `remove`'da da aynısı oluyor **ve worktree yerinde
      kalıyor**).
- [x] `wtm explain` içinde göster. — `git.allowed_remote_refs` bir `config` kararı olarak çıkıyor,
      değeri ve provenance'ıyla; `decisions.test.ts` → "surfaces the configured [git]
      allowed_remote_refs as a config decision, for `wtm explain`".
- [x] Kullanıcı dokümantasyonuna yaz. — **bu maddede yapılan tek yeni iş.** Anahtar şemada vardı
      ama hiçbir kullanıcı dokümanında geçmiyordu, yani ayarlanabilir olduğu halde keşfedilemezdi.
      `docs/03-configuration-spec.md`'e "Git safety" bölümü eklendi: varsayılan, listenin
      *eklemediği* ama tamamen *değiştirdiği* (dizi birleştirilmiyor, `config/merge.ts` diziyi
      yaprak sayıyor), üç doğrulama kuralı, `WTM_CONFIG_INVALID` davranışı ve `--refresh-remotes`
      ile bağı. `docs/10-git-safety-worktree-analysis.md`'in "configuration may expand/restrict
      this" cümlesi de artık anahtarı adıyla söyleyip oraya bağlanıyor.

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

- [x] `systemd --user` service installer/uninstaller.
- [x] `systemctl --user` lifecycle.
- [x] XDG directory resolution.
- [x] Unix socket path policy.
- [x] POSIX process group supervision.
- [x] Linux process start-time / identity verification.
- [x] inotify/fs.watch davranış testleri.
- [x] Linux permission / symlink semantics testleri.
- [ ] ARM64 + x64 binary build pipeline. — x64 tamam (`binary:verify` ubuntu bacağında yeşil,
      `dist/sea/wtm … linux-x64`); **arm64 yok**, Linux CI matrisinde arm64 runner yok.

> **Linux x64 CI yeşil, 2026-09-02** (`33655596273`). Bu kutular gerçek bir çekirdekte koşan
> testlerle işaretlendi, fixture'larla değil: süreç grubu sonlandırma ve anchor'ın platform
> port'uyla canlı mutabakatı, `.git` altına sonradan eklenen bir worktree'yi özyinelemeli
> inotify ile yakalayan reconciliation, ve 17 symlink/izin testi. `sizeof(sun_path)` = 108 ve
> inode numarası yeniden kullanımı da artık alıntı değil ölçüm.
>
> Maddenin kendisi açık kalıyor: Windows yarısı Increment D.

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

- [ ] IPC için Unix socket yerine Named Pipe backend. — `IpcServerPublisher` portu ve
      `UnixSocketPublisher` (server.ts'in hardlink/chmod/uid dansı, davranış değişmeden taşındı)
      ile Windows `listen()` gövdesi Increment D1'de yazıldı; gerçek bir named pipe'a karşı
      doğrulanmadı (Increment D2).
- [ ] Process supervision için Windows Job Objects veya güvenli eşdeğer. — güvenli eşdeğer seçildi
      ve yazıldı: `ProcessPlatform` artık gerçek bir Windows gövdesine sahip
      (`Get-CimInstance Win32_Process` ile kimlik/ağaç okuma, `taskkill /T /F` ile sonlandırma),
      17 fixture testiyle kanıtlandı. Gerçek bir Windows kernel'e karşı doğrulanmadı, `win32`
      `supportedPlatforms`'a hâlâ dahil değil — Increment D2 kapanmadan önce kalan iş. Detay:
      `2026-09-04-windows-process-supervision.md`.
- [ ] Child process tree cleanup. — `taskkill /PID <pgid> /T /F` yazıldı (yukarıdaki madde), kök
      süreç ölmüşken yetim alt süreçleri de bulacak şekilde (Windows ölü parent'ın
      `ParentProcessId`'ini temizlemiyor); gerçek bir ağaçta doğrulanmadı.
- [ ] PID reuse kontrolü için process creation time. — `ProcessPlatform.readStartTime` Windows'ta
      `CreationDate` (round-trip ISO) okuyor; ağaç yürüyüşü de aynı alanla parent pid yeniden
      kullanımına karşı korunuyor (yukarıdaki madde). Gerçek bir Windows'ta ölçülmedi.
- [ ] Windows path canonicalization.
- [ ] Drive letter / UNC path desteği.
- [ ] NTFS junction, symlink ve reparse point güvenliği.
- [x] `LOCALAPPDATA` / `APPDATA` tabanlı WTM paths. — `windowsPlatformPaths`, `node:path/win32`
      ile inşa edildi (varsayılan `node:path` bu Mac'te POSIX'tir ve `C:\...` yolunu tanımaz —
      Increment D1'in kendi bulgusu), env injection ile test edildi.
- [ ] Per-user daemon lifecycle stratejisi. — karar verildi (per-user Scheduled Task, admin
      gerektirmiyor) ve `windowsServiceBackend` sahte `schtasks`/`sc.exe` ile test edildi; gerçek
      Task Scheduler üzerinde doğrulanmadı, Increment D2.
- [ ] PowerShell uyumlu install/uninstall.
- [ ] PowerShell completion.
- [ ] Git Bash kullanımının ayrıca test edilmesi.
- [ ] Windows ARM64 ileride; ilk hedef Windows x64.
- [ ] Native Windows CI.

> **Windows trust seam, 2026-09-03 (Increment D1, kısmi).** `FileTrustPolicy` portu —
> "bu benim mi" / "başkası yazabiliyor mu" / "hardlink ile paylaşılmış mı" — `@wtm/platform`'da
> POSIX+Windows (ACL, `powershell.exe` `Get-Acl` üzerinden) olarak inşa edildi, ve `@wtm/core`
> içindeki 151 satırlık dağınık `process.getuid()`/mode-bit/nlink kontrolü 7 dosyada bu porta
> taşındı — hiçbir mevcut testin assertion'ı değişmeden (352→356 test, hepsi yeşil). Windows
> `ServiceBackend` (Scheduled Task) ve `windowsPlatformPaths` de bu artırımda geldi. Hepsi
> fixture/sahte runner ile kanıtlandı, gerçek bir Windows kernel'de değil — C1'in Linux için
> tuttuğu ayrım burada da geçerli. Detay: `2026-09-03-windows-trust-and-transport-seam.md`.
>
> **D7 kapatıldı, 2026-09-03.** `IpcServerPublisher` portu `@wtm/platform`'a eklendi:
> `UnixSocketPublisher` `server.ts`'in hardlink/chmod/uid dansının birebir taşınmış hali (24
> entegrasyon testi, hiçbir assertion değişmeden yeşil), Windows gövdesi düz `listen()` —
> named pipe'ın quarantine edilecek bir "stale" hali olmadığı bulgusuna dayanarak — sahte bir
> `net.Server`'a karşı test edildi. Gerçek bir named pipe veya ikinci bir Windows hesabına karşı
> kanıtlanmadı; bu hâlâ Increment D2'nin işi.
>
> **D2, 1. geçiş, 2026-09-04.** `ProcessPlatform` artık dördüncü bir metoda sahip:
> `signalProcessGroup(pgid, signal)` — daha önce hiç port'a bağlı değildi, supervisor'ın kendi
> varsayılanı doğrudan `process.kill(-pgid, signal)` çağırıyordu ve `runtime-factory.ts` bunu hiç
> enjekte etmiyordu (gerçek bir POSIX-only sızıntı, bu geçişte kapatıldı). Windows gövdesi:
> kimlik ve ağaç okuma `Get-CimInstance Win32_Process` ile, sonlandırma `taskkill /PID <pgid> /T
> /F` ile — Job Object değil, `todo.md`'nin kendi "güvenli eşdeğer" izniyle seçildi, çünkü bir Job
> Object handle'ı daemon restart sonrası tekrar sorulabilecek kalıcı bir kimlik değil. `pgid`
> Windows'ta kernel'in tuttuğu bir şey değil; bu proje zaten her platformda `pgid === pid`
> (lider kendi kendinin grubu) invaryantını uyguluyor, Windows bunu istismar ediyor: "grup"
> o pid'den başlayan canlı süreç ağacı. Kök süreç ölmüşken yetim alt süreçlerin hâlâ
> bulunabildiği ayrıca doğrulandı (Windows ölü parent'ın `ParentProcessId`'ini temizlemiyor).
> Anchor'ın kendi inline Windows reader'ı da yazıldı (`process-anchor.ts`, `@wtm/platform`
> import edemediği için zorunlu kopya, darwin/linux'un yanına) ve platform portuyla aynı
> fixture JSON üzerinden aynı sonucu verdiğini kanıtlayan 3 yeni test eklendi. Toplam 20 yeni
> test, hepsi yeşil (1306/1307). Hiçbiri gerçek bir Windows kernel'e karşı çalışmadı;
> `supportedPlatforms` hâlâ `win32`'yi reddediyor ve Windows CI leg'i hâlâ yok — ikisi de
> kasıtlı olarak bu geçişin dışında bırakıldı. Detay: `2026-09-04-windows-process-supervision.md`.
>
> **CI doğrulaması, 2026-09-04.** Run `33846848105`: üç mevcut leg de (darwin arm64, darwin x64,
> linux x64) yeşil, aynı 1306/1 sayımıyla. İlk denemede `darwin x64` 30 dakikalık job limitine
> takılıp iptal oldu, ama log takılmanın bu geçişin hiç dokunmadığı `init.test.ts`'te olduğunu
> gösterdi (`windows.ts`/`process-anchor.ts`/`process-supervisor.ts` import edilmiyor); düz bir
> rerun aynı adımı 3m44s'de bitirdi — `endpoints.ts`'nin belgelediği bu leg'in kendine özgü,
> ilgisiz flake geçmişiyle aynı kategori, bu geçişin kodundan bağımsız. Bu pass artık kapalı;
> Increment D2'nin tamamı için `supportedPlatforms`/gerçek Windows CI leg'i hâlâ açık.
>
> **D2, 2. geçiş, 2026-09-04.** `supportedPlatforms` artık `win32`'yi kabul ediyor;
> `windowsPlatformPaths`'in `socketRoot`'u gerçek bir named-pipe adresine düzeltildi
> (`\\.\pipe\wtm-<sha256(dataRoot)>` — eski `dataRoot` değeri hiçbir `listen()` çağrısına karşı
> hiç sınanmamış bir arayüz-parity alanıydı, bu geçişte gerçek bir kusur olduğu bulundu). SEA
> build'i Windows'u destekliyor (`wtm.exe`, strip Windows'ta bilinçli olarak atlanıyor — gerekçe
> spec'te). `ci.yml`'e kullanıcının kendi "tam kapsam" kararıyla darwin/linux ile **aynı 7 adımı**
> koşan bir `windows-latest` leg'i eklendi. `process-supervisor.test.ts` ve testkit
> (`writeExecutableFixture`, `resolveRealExecutablePath`) artık POSIX-only shebang/`process.kill`
> varsayımı taşımıyor. `package.json`'ın `os` alanı `ci.yml` matrisiyle mekanik olarak eşleşiyor
> (`package-contents.test.ts`). Yerelde (bu macOS host) `lint`, `typecheck`, `test` (1310/0),
> `test:e2e`, `build`, `package:verify`, `binary:verify` hepsi yeşil. Gerçek `windows-latest`
> koşusu henüz görülmedi — bu geçişin kendi kabul kriteri, spec'in kendi sözüyle "yalnızca gerçek
> bir CI koşusu destekleyebildiğinde" kapanacak. Bilinçli olarak dışarıda bırakılanlar:
> `inode-reuse-measurement.test.ts`'nin win32 durumu (NTFS nlink-reuse semantiği ölçülmedi),
> `quick-start.test.ts`'nin `/bin/sh` bağımlılığı, `service-lifecycle.ts`'nin `getuid` boşluğu
> (Windows daemon lifecycle kararına bağlı), ve `release-artifacts.ts`/`verify-release.ts`
> (Increment E'nin işi). Detay: `2026-09-04-windows-ci-leg-and-supported-platform.md`.

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

- [x] Core package platform-independent. — `platform-independence.test.ts` yapısal olarak
      zorluyor; iki gözden geçirilmiş istisna var, ikisi de tabloda gerekçesiyle yazılı.
- [x] Platform-specific import'lar platform package dışında minimum.
- [~] macOS regression yok. — `75a8626` / `34457543774` ARM64 bütün gate'lerde yeşil;
      Intel x64 1629 pass / 2 fail. Rotation gözlem/recovery kusuru düzeltildi; stale process
      identity nedeni henüz kanıtlanmadı, failure-only native trace eklendi. Önceki yeşil koşu
      bu yeni kırmızılığı kapatmaz.
- [x] Linux x64 CI green. — `75a8626` / `34457543774`: test 1627/0, e2e 3/0, binary 10/0;
      lint/typecheck/build/package geçti. Takip yamalarının native kanıtı ayrıca izlenir.
- [ ] Linux arm64 build doğrulanıyor.
- [ ] Windows x64 CI green. — **2026-09-10 takip yeniden başladı.** `75a8626` koşusunda
      1327 pass / 115 fail / 200 skip ve bir testler-arası error; sonraki gate'ler çalışmadı.
      Native log, anchor'da yanlış POSIX 0700 kontrolünü somut olarak gösteriyor; SID/ACL
      capability düzeltmesi geliştiriliyor. Custom state-root pipe adresi ve fixture Windows
      home izolasyonu düzeltildi. Gerçek native sonuç gelmeden bu madde kapanmaz.
      Önceki incelemeler tarihsel notlarında korunur; güncel kayıt
      `docs/development/2026-09-10-windows-follow-up.md`.
- [ ] Aynı `wtm.toml` mümkün olduğunca üç OS'ta da çalışıyor.
- [ ] JSON contract platformlar arasında aynı kalıyor. — `definitionPath` her platformda var;
      `plistPath` macOS'a özel bir ek alan olarak bilerek duruyor (D11), kaldırılması daemon JSON
      sözleşmesini kırmak için bağımsız bir nedeni olan ilk artıma programlandı.
- [x] CLI command names platforma göre değişmiyor. — aynı komut listesi iki platformda da
      `main.test.ts` tarafından sabitleniyor.
- [x] Platform-specific farklar `wtm doctor` ile açıkça raporlanıyor.

---

### [x] 44. Ağ üzerinden paylaşılan `HOME`'da lease sahibi yanlışlıkla "gitmiş" okunuyor

Increment C1'de, platform seam'i tasarlanırken bulundu; spec `2026-09-01-platform-seam-design.md`
D5 ayrıntısını taşıyor.

WTM her supervised process ve her destructive-operation lease için bir `(pid, process start time)`
çifti saklıyor; PID reuse'u yakalayan şey bu çift. Start time string'i platforma göre farklı
yazılıyor: macOS `ps`'in `lstart` çıktısını (`Mon Sep  1 12:00:00 2026`), Linux `/proc` üzerinden
`<btime>:<starttime>` yazıyor. İki format asla eşit olamaz -- bu bilinçli, tek bir state kolonunun
iki platformu versiyon etiketi olmadan taşımasını sağlayan şey de bu.

Eşit olamamaları, karşılaşamayacakları anlamına gelmiyor. Bir macOS makinesiyle bir Linux makinesi
aynı `HOME`'u ağ dosya sistemi üzerinden paylaşırsa ortada tek bir `state.db` var ve her host
diğerinin yazdığı kimliği "başka bir process" olarak okuyor.

- Supervised process kaydı için bu güvenli.
- **Lease için değil.** "Başka process" demek "sahibi gitmiş, lease geri alınabilir" demek; oysa
  sahip diğer host'ta hâlâ çalışıyor olabilir. Lease'lerin serileştirdiği işlemler worktree siliyor.

Çözüm bir host identity kolonu: kimlik yalnızca aynı host'ta karşılaştırılmalı, farklı host'un
tuttuğu satır `gone` değil `unknown` sayılmalı. Bu bir state schema değişikliği olduğu için C1
kapsamına alınmadı.

Maruziyet iki yerden birden dar, ve ikisi de kapanma aciliyetini düşürüyor: ağ üzerinden paylaşılan
bir `HOME` **ve** iki işletim sisteminden eşzamanlı destructive işlem gerekiyor; üstelik liveness
yalnızca TTL'i (varsayılan 120 sn) dolmuş bir satır için soruluyor, süresi dolmamış bir sahip zaten
ölçülmeden conflict sayılıyor. Buna karşılık WTM Linux'ta gerçekten çalışmaya başlamadan önce
kapanmalı: bugün ulaşılamaz olmasının tek sebebi Linux'un henüz çalışmaması.

#### Yapılacaklar

- [x] Lease satırlarına host identity kolonu ekle; migration yaz. — migration 011
      (`repository_operation_leases.host_id`, `DEFAULT ''`); process kayıtlarına (`managed_processes`)
      eklenmedi, bkz. aşağıdaki not.
- [x] Host identity'yi platform seam'inden üret; `HOME`'a değil makineye bağlı olsun. —
      `os.hostname()`, CLI composition root'unda (`main.ts`) üretiliyor; core hâlâ hiçbir OS çağrısı
      yapmıyor, değeri parametre olarak alıyor (`RepositoryOperationLeaseInput.hostId`), tıpkı
      `readProcessStartTime` gibi.
- [x] Liveness karşılaştırmasını host-aware yap: farklı host -> `unknown`, asla `gone`. —
      `operation-lease.ts`'in `livenessOf`'u artık `'alive' | 'unknown' | 'gone'` döndürüyor; store
      tarafı (`sqlite-store.ts`) `unknown`'ı `alive` ile aynı şekilde ele alıyor (yalnızca `gone`
      lease'i `abandoned` yapabiliyor).
- [x] Host bilgisi taşımayan eski satırların nasıl yorumlanacağına karar ver ve testle. — Karar: boş
      `host_id` gerçek bir host id'sine asla eşit olamayacağı için otomatik olarak `unknown` okunuyor
      (farklı host'tan ayrı bir kural gerekmiyor); `operation-lease.test.ts`'te ayrı test var.
- [x] İki platformun kimlik string'lerini taşıyan tek bir `state.db` üzerinde test ekle. —
      `operation-lease.test.ts`'te host uyuşmazlığı senaryosu (macOS `lstart` tarzı ve Linux `/proc`
      tarzı string'ler karışabilir; test bu iki formatın karşılaştırılamayacağını değil, host_id
      farkının nasıl ele alındığını doğruluyor) ve `sqlite-store.scenario.ts`'te gerçek SQLite
      üzerinde `unknown` verdict'inin `conflict` (asla `abandoned`) ürettiğini doğrulayan test.

#### Kabul kriterleri

- [x] Başka bir host'un tuttuğu lease yalnızca TTL dolduğu için geri alınıyor; kimlik farkı tek
      başına gerekçe olmuyor. — `unknown` verdict'i her zaman `conflict`, asla `abandoned`.
- [x] Aynı host üzerindeki PID reuse tespiti bugünkü davranışını koruyor. — mevcut
      "treats a holder whose start time no longer matches as gone" testi değişmeden geçiyor.

> **Kapanış notu, 2026-09-06.** Kapsam bilinçli olarak daraltıldı: `managed_processes`
> (supervised process kayıtları) host_id almadı, çünkü bu maddenin kendi metni bu kaydın bugün
> güvenli olduğunu söylüyor (yanlış "gone" okuması yalnızca lease'in serileştirdiği yıkıcı işlemler
> için tehlikeli) — kullanılmayacak bir kolon eklemek gereksiz yüzey olurdu. İleride supervised
> process tarafı da host-aware olması gerekirse aynı desen (`hostId` parametresi, port'tan asla OS
> çağrısı) tekrarlanabilir. `readProcessStartTime` ile aynı disipline uyuldu: `hostId` her çağıran
> için zorunlu, varsayılan değeri yok — bu yüzden `@wtm/core`'un mevcut tüm lease çağrı noktaları
> (üretim ve test) `hostId` geçmeye zorlandı, TypeScript bunu derleme zamanında garanti ediyor.

---

### [x] 10. Managed task readiness / healthcheck ekle

`wtm start dev` process doğduğu için başarılı sayılmamalı; kullanıcı isterse servisin hazır olmasını bekleyebilmeli.

**2026-09-10:** HTTP dilimi uygulandı: start/restart wait, config/template, sınırlı observation,
process/completion identity, IPC cancellation ve JSON hata sözleşmesi. Gerçek HTTP + TCP IPC
üzerinden 5,5 saniyeden uzun wait, timeout ve iptal geçti. `75a8626` için Linux x64 ve macOS
ARM64 native e2e geçti; observer/controller bağımsız review’u tamamlandı. Bu ortamda Unix
socket `listen EPERM`, Windows native kabulü ve ayrı Intel lifecycle hatası açık. Tasarım ve kanıt: `docs/development/2026-09-10-todo-continuation.md`.

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

Uygulanan tip `http`; `tcp`, `process` ve `command` gelecekteki genişletmelerdir.

#### Kabul kriterleri

- [x] Process spawn olup servis ayağa kalkmazsa wait sonucu timeout veya process/evidence hatasını gösteriyor.
- [x] JSON output readiness durumunu içeriyor; normal start `NOT_CHECKED`, başarılı wait `READY`.
- [x] Agent’lar başarılı `READY` sonucunu aynı managed process ve HTTP endpoint için o andaki
      readiness kanıtı olarak kullanabiliyor; gelecekteki sağlık veya endpoint ownership garantisi yok.

---

### [x] 11. Shell completion ekle

Destek:

- [x] zsh
- [x] bash
- [x] fish

Örnek:

```bash
wtm completion zsh
wtm completion bash
wtm completion fish
```

Completion kaynakları:

- [x] commands
- [x] task names
- [x] worktree selectors
- [x] repo selectors

> **Kapatıldı, 2026-09-05.** `wtm completion {bash,zsh,fish}` üç script'i de üretiyor;
> `wtm __complete {tasks,worktrees,repos}` her shell'in çağırdığı gerçek veri kaynağı
> (`productionCompletionData`, `packages/cli/src/main.ts`) — task adları `allocate: false` ile
> resolve ediliyor ki bir shell'de Tab'a basmak bir endpoint lease'i almasın. `main`'e merge
> edilirken `packages/cli/src/main.ts`'te aynı noktaya eklenmiş ilgisiz bir fonksiyon grubuyla
> (item 43'ün `workspaceRootNotRepositoryError`'ı) çakıştı, ikisi de korunarak çözüldü. Tam test
> paketi merge sonrası yerelde yeşil (1357/0, 1 skip).

---

### [ ] 47. Task komutlarına worktree selector'ü ekle (`--worktree <selector>`)

`wtm run/start/stop/restart/logs/exec` yalnızca bulunulan dizinin worktree'sinde çalışıyor. Başka
bir feature'ı ayağa kaldırmak için `cd` şart. Bir ajan ya da çok feature'lı bir oturum için bu
kırılgan: her komuttan önce dizin değiştirmek gerekiyor ve dizin değiştirme oturumun geri kalanını
da etkiliyor.

#### Beklenen akış

```bash
wtm start web:dev --worktree feat/auth
wtm logs web:dev --worktree feat/auth
wtm stop --worktree feat/auth
wtm run test --worktree 13 --repo web
```

Selector resolver zaten var: `status`, `analyze` ve `remove` branch adı, dizin adı, numara ve path
kabul ediyor, çoklu eşleşmede `WorktreeSelectorError` üretiyor
(`packages/cli/src/commands/remove.ts:73-222`). Bu madde yeni bir grammar icat etmemeli; mevcut
resolver'ı ortak bir yere çıkarıp task komutlarına taşımalı.

Çok depolu bir feature'da tek bir branch birden fazla worktree demek. Repo ayrıştırmasının nasıl
yapılacağı (`--repo <name>` mi, `<repo>:<selector>` biçimi mi, yoksa ikisi de mi) bu maddede karara
bağlanmalı — task adı zaten `web:dev` biçiminde iki parçalı olduğu için `<repo>:<selector>`
seçilirse çakışma riski ayrıca değerlendirilsin.

6. madde (`wtm create`) worktree'yi henüz var olmadan adlandırıyor, bu madde ise var olanı seçiyor;
ikisinin ürettiği isim ve selector grameri aynı olmalı, `create` sonrası dönen kimlik doğrudan
`--worktree` değeri olarak kullanılabilmeli.

#### Yapılacaklar

- [ ] Selector resolver'ı `remove.ts`'ten ortak bir modüle çıkar; `status`/`analyze`/`remove`
      davranışı bit düzeyinde değişmesin.
- [ ] `--worktree <selector>` bayrağını `run`, `start`, `stop`, `restart`, `logs`, `exec`
      komutlarına ekle.
- [ ] Repo ayrıştırma kararını uygula ve tek biçim olarak sabitle.
- [ ] Bayrak verilmediğinde davranış bugünkü gibi kalsın: bulunulan dizinin worktree'si.
- [ ] Workspace kökünden (worktree dışından) çağrıldığında `--worktree` zorunlu olsun ve eksikse
      eyleme dönük hata versin, ham stack trace değil.
- [ ] Belirsiz eşleşmede `WorktreeSelectorError` aynı stable JSON error code ile dönsün.
- [ ] Shell completion (`wtm __complete worktrees`) bu bayrağı da beslesin.
- [ ] `docs/04-cli-reference.md`'de altı komutun tamamında bayrağı belgele.
- [ ] `docs/11-ai-first-skill-integration.md` ve `skills/wtm/SKILL.md`'de `cd` gerektirmeyen akışı
      örnekle; ajanın önerilen yolu bu olsun.

#### Kabul kriterleri

- [ ] Altı komut da worktree dışından, `cd` olmadan hedef worktree'de çalışıyor.
- [ ] Aynı branch birden fazla repoda varken repo ayrıştırması deterministic.
- [ ] Belirsiz selector hiçbir komutta yanlış worktree'yi seçmiyor; hata veriyor.
- [ ] `--worktree` olmadan çağrılan komutların davranışı değişmemiş.

---

### [ ] 48. Workspace Makefile'ı worktree bağlamında çalıştırılabilsin

Bugün make adapter'ı iki aile üretiyor (`packages/adapters/src/make.ts:48-64`): `make:<target>`
worktree'nin kendi Makefile'ını worktree kökünde, `workspace:<target>` kök Makefile'ı workspace
kökünde çalıştırıyor. Arada kalan ve asıl istenen üçüncü hâl yok: kök Makefile'daki bir hedefi bu
worktree'nin dizininde çalıştırmak.

Alan kurulumunda bu şuna yol açtı: `api` worktree'sinde `make:dev` → `make dev` → paket script'i →
komut satırında sabit `--port 4000` taşıyan bir dev server. WTM'in tahsis ettiği portu kullanmak
için kullanıcı `wtm.toml`'a servis başına `api:dev`, `web:dev`, `worker:dev` … görevlerini elle
yazmak zorunda kaldı. Hepsi kök Makefile'ın zaten bildiği komutların kopyası; kök Makefile
değiştiğinde bu kopyalar sessizce bayatlıyor.

Şart: Makefile kopyalanmasın veya symlink'lenmesin. WTM hedefi kendi state DB'sinde bir task kaydı
olarak tutsun (49. madde) ve çalıştırma anında `-f <workspace>/Makefile` + `cwd = {worktree.root}`
ile çözsün.

#### Karara bağlanacaklar

- [ ] İsim alanı: `workspace:<target>` mevcut davranışını korusun. Worktree bağlamı için ayrı bir ön
      ek mi (`workspace-here:<target>`), yoksa `--cwd worktree` bayrağı mı?
- [ ] `make -f` ile çalışan bir Makefile'ın göreli yolları kırılıyor (`$(ROOT_DIR)`,
      `../.cache/state`). WTM hangi değişkenleri enjekte edecek (ör. `WTM_WORKTREE_ROOT`,
      `WTM_WORKSPACE_ROOT`) ve neyi kullanıcıya bırakacak — açıkça yazılsın.
- [ ] Aynı davranış diğer task-runner adapter'ları (bun scripts, just, task) için de geçerli mi,
      yoksa yalnızca make'e mi özel? Genelleşecekse bu, adapter contract'ına eklenen bir alan
      demek — 21. maddedeki contract versioning ile aynı turda ele alınsın.

#### Yapılacaklar

- [ ] İsim alanı kararını uygula; `workspace:<target>` semantiği değişmesin.
- [ ] Çalıştırma anında `-f <workspace>/Makefile` + `cwd = {worktree.root}` çözümü; hiçbir noktada
      Makefile kopyalama veya symlink yok.
- [ ] Enjekte edilen değişken setini sabitle ve belgele.
- [ ] Port lease'i bu yolla çalışan hedeflere de aynı şekilde ulaşsın; kullanıcı sabit portu
      Makefile'da tutuyorsa bunun override edilemeyeceğini hata mesajında söyle.
- [ ] Adapter'ın ürettiği bu üçüncü aile `wtm explain` çıktısında kaynağıyla görünsün.
- [ ] `docs/03-configuration-spec.md`'ye yeni isim alanı ve değişken sözleşmesi.
- [ ] `docs/04-cli-reference.md`'ye task adı biçimleri.
- [ ] `docs/06-adapter-protocol.md`'ye adapter'ların `cwd` seçimini nasıl bildireceği.
- [ ] `skills/wtm/SKILL.md`'de üç ailenin farkını ajanın karıştırmayacağı biçimde anlat.

#### Kabul kriterleri

- [ ] Kök Makefile'daki bir hedef, worktree dizininde, Makefile kopyalanmadan çalışıyor.
- [ ] Kök Makefile değiştiğinde `wtm.toml`'da elle bakım gerektiren kopya kalmıyor.
- [ ] Üç ailenin (`make:`, `workspace:`, worktree bağlamı) hangisinin ne yaptığı `wtm explain`
      çıktısından anlaşılıyor.
- [ ] Göreli yol kıran bir Makefile için hata mesajı hangi değişkenin eksik olduğunu söylüyor.

---

### [ ] 49. Task kayıtları DB'de tutulsun ve düzenlenebilir olsun (ajan tarafından)

48. maddenin ön koşulu. Bugün bir task ya `wtm.toml`'da yazılı ya da bir adapter'ın ürettiği türev.
İkisinin arasında, "WTM'in kendi kaydettiği, sonradan düzenlenebilen task" diye bir şey yok.
Kurulumda ortaya çıkan ihtiyaç şu: bir ajan, bir worktree için türetilmiş komutu (port bayrağı, ek
argüman, `cwd`) düzeltip kalıcı hâle getirebilmeli — kullanıcının `wtm.toml`'unu elle yeniden
yazmadan.

#### Hedef yüzey

```bash
wtm task list --json
wtm task show <name> --json
wtm task set <name> --run '...' --cwd '{worktree.root}' --json
wtm task unset <name>
```

#### Karara bağlanacaklar

- [ ] Öncelik sırası: `wtm.toml` her zaman kazanmalı mı, yoksa DB kaydı override mı? Mevcut
      precedence zinciri `docs/03-configuration-spec.md`'de; yeni katman oraya açıkça yazılmalı,
      ima edilmemeli.
- [ ] Kaynak provenance: `wtm explain` bir task'ın DB'den mi TOML'dan mı geldiğini satır/kaynak
      düzeyinde söylemeye devam etmeli.
- [ ] Kalıcılık ve taşınabilirlik: DB kaydı makineye bağlı, ekip arkadaşı aynı task'ı görmüyor.
      `wtm task export` ile `wtm.toml`'a düşürme yolu olmalı mı?
- [ ] Güvenlik: keyfi argv'yi kalıcılaştıran bir yüzey. Adapter trust registry (21. madde) ile aynı
      güven modeline oturmalı; ayrı bir onay mekanizması doğmamalı.

#### Yapılacaklar

- [ ] State DB'de task override tablosu; scope (workspace / repo / worktree) açıkça modellensin.
- [ ] `wtm task list|show|set|unset` komutları, hepsinde stable `--json`.
- [ ] Precedence kararını uygula ve `wtm explain`'de kaynağı göster.
- [ ] Placeholder'lar (`{worktree.root}`, `{workspace.root}`, port lease'leri) DB kayıtlarında da
      aynı biçimde çözülsün; ikinci bir interpolation dili doğmasın.
- [ ] Trust modeli: DB'ye yazılan argv'nin hangi onaydan geçtiğini kaydet.
- [ ] `wtm remove` bir worktree'yi kaldırdığında ona bağlı task kayıtları da temizlensin.
- [ ] Export kararı uygulanırsa `wtm task export` ile `wtm.toml`'a düşür.
- [ ] `docs/03-configuration-spec.md`'ye yeni precedence katmanı.
- [ ] `docs/04-cli-reference.md`'ye `wtm task` komut ailesi.
- [ ] `docs/06-adapter-protocol.md`'ye adapter türevlerinin DB kaydıyla ilişkisi.
- [ ] `docs/11-ai-first-skill-integration.md` ve `skills/wtm/SKILL.md`'ye ajanın task düzeltme
      akışı ve yapmaması gerekenler.

#### Kabul kriterleri

- [ ] Bir ajan türetilmiş bir task'ı düzeltip kalıcılaştırabiliyor; `wtm.toml` elle düzenlenmiyor.
- [ ] `wtm explain` her task için kaynağını (TOML satırı / adapter / DB kaydı) söylüyor.
- [ ] Precedence dokümanda yazdığı gibi çalışıyor ve parity testiyle sabitleniyor (34/35. maddeler).
- [ ] Worktree kaldırıldığında ardında yetim task kaydı kalmıyor.

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

### [ ] 46. Dev overlay: çalışan web uygulamasına worktree kimliğini ve ajan test adımlarını bas

Aynı anda üç dört feature'ın `web`'i ayakta olduğunda, tarayıcıdaki bir sekmenin hangi worktree'ye
ait olduğunu yalnızca port numarası söylüyor. Port da lease'e göre kayıyor: alan kurulumunda
`api` tercih ettiği 4000'i alamadı, 3004'e düştü. Kullanıcı yanlış sekmede test ediyor ve bunu fark
etmiyor. WTM hangi portun hangi worktree'ye ait olduğunu zaten biliyor; bu bilgi kullanıcının
baktığı yere, yani sayfanın kendisine ulaşmıyor.

WTM ile ayağa kaldırılan bir web dev server'ı sayfaya küçük bir overlay enjekte etmeli. Biçim olarak
Astro dev toolbar / Next dev indicator mantığında, ama içeriği WTM'den gelmeli.

#### Overlay'in göstereceği

```text
feature/branch, worktree numarası ve dizini, repo adı
bu feature'ın tüm endpoint'leri (kardeş repolar dahil), tıklanabilir
resource durumu (ready / missing)
o an supervised çalışan task'lar
ajanın yazdığı test adımları (kontrol listesi)
```

Test adımları tek yönlü olmamalı: bir ajan `wtm` üzerinden worktree'ye bir kontrol listesi
yazabilmeli, overlay bunu maddeler halinde göstermeli, kullanıcı işaretleyince durum WTM'in state
DB'sine geri yazılmalı. Kalıcı task kaydı yüzeyi 49. maddede tanımlanıyor; kontrol listesi de aynı
yerde durmalı, ayrı bir depolama icat edilmemeli.

#### Karara bağlanacaklar

- [ ] Enjeksiyon katmanı: framework başına adapter (Astro integration, Vite plugin, Next dev
      middleware) mı, yoksa 12. maddedeki local reverse proxy'de HTML'e tek noktadan enjeksiyon mu?
      İkincisi framework-agnostik. Bu madde 12'yi beklemeli mi, yoksa proxy gelene kadar adapter
      yolundan mı yürünmeli — karar maddeye yazılsın.
- [ ] Opt-in mi opt-out mu (`[dev-overlay] enabled = true`), ve repo bazında kapatma.
- [ ] Overlay'in veri kaynağı `wtm status --json` ile aynı kontrat olmalı; overlay'e özel ikinci bir
      şema doğmamalı.

#### Yapılacaklar

- [ ] Enjeksiyon katmanı kararını uygula; hangi yol seçilirse seçilsin enjeksiyon yalnızca dev
      modunda ve yalnızca loopback bind'de çalışsın.
- [ ] Prod build'e sızma yolu olmadığını gösteren test yaz — bu, özelliğin kabul şartı.
- [ ] Overlay veri ucu: `wtm status --json` şemasının bir alt kümesi, ayrı contract değil.
- [ ] Ajanın kontrol listesi yazması ve kullanıcının işaretlemesi için iki yönlü uç.
- [ ] Kardeş repoların endpoint'leri feature identity üzerinden çözülsün, port taramasıyla değil.
- [ ] Konfigürasyon: global ve repo bazında etkinleştirme/kapatma.
- [ ] `docs/03-configuration-spec.md`'ye `[dev-overlay]` bölümü.
- [ ] `docs/04-cli-reference.md`'ye overlay ile ilgili komut/bayrak parity'si.
- [ ] Adapter yolu seçilirse `docs/06-adapter-protocol.md`'ye enjeksiyon sözleşmesi.
- [ ] `docs/11-ai-first-skill-integration.md` ve `skills/wtm/SKILL.md`'ye ajanın kontrol listesi
      yazma akışı.

#### Kabul kriterleri

- [ ] Üç feature'ın `web`'i aynı anda ayaktayken her sekme kendi worktree'sini sayfadan söylüyor.
- [ ] Overlay hiçbir prod build'de yer almıyor ve loopback dışı bir bind'de enjekte edilmiyor.
- [ ] Ajanın yazdığı kontrol listesi kullanıcı tarafından işaretleniyor ve durum WTM'de kalıcı.
- [ ] Overlay kapatıldığında dev server davranışı WTM'siz haline birebir eşit.

---

## P2 — Analysis ve UX iyileştirmeleri

### [x] 16. Ignored dosyaları `untracked` grubundan ayır

**Tamamlandı, 2026-09-09.** Porcelain `!` kayıtları artık `workingTree.counts.ignored`,
`workingTree.paths.ignored` ve `ignored` classification'ında; `?` kayıtları `untracked` altında.
Yeni `GIT_IGNORED_CONTENT` kodu silmede exit 3 üretir. İki grup da silmeyi engeller;
WTM'nin temizleyeceği ephemeral kaynakların tamamını kapsayan blocker'lar runtime cleanup'a
ertelenebilir. Cleanup sonrası analiz, geride kalan veya yeni oluşan ignored kullanıcı
verisini tekrar engeller. İki gruptaki symlink'ler mevcut politikayı korur; ENOENT dışındaki
inceleme hataları güvenli kabul edilmez.

Kanıt: `status-parser.test.ts`, `worktree-analysis.integration.test.ts`,
`guarded-remove.integration.test.ts`, `git-environment.test.ts`, `ignored-content.test.ts`
ve `exit-codes.test.ts`. `.gitignore`, `info/exclude`, global excludes, ignored dizin,
symlink, karma kullanıcı/kaynak verisi, cleanup sırasında oluşan dosya ve CLI JSON/exit
senaryoları kapsanıyor. Counts, Git'in döndürdüğü entry sayısıdır; ignored dizin tek entry olabilir.

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

### [x] 17. Symlink removal policy configurable olsun

**2026-09-10 tamamlandı:** Varsayılan `ignore`, advisory `review`, non-deferrable `block` uygulandı. Hedef worktree’nin
`.wtm.toml` politikası selector’dan sonra çözülür; iki removal gate’ine aynı context gider.
Ignored içerik ve final unforced Git veto korunur. Bağımsız review bulgusu regresyon testiyle
giderildi. Kanıt: `docs/development/2026-09-10-symlink-policy.md`.

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

**2026-09-10:** Node ve standalone tahsis yolu artık en fazla 256 adayı tek helper'a gönderir.
SQLite transaction içindeki lease çakışma filtresi, mevcut port ve preferred port sırası korunur.
İki saniye toplam süre, 128 KiB stdin ve 4 KiB yanıt sınırı vardır; bozuk/eksik yanıt veya
timeout port tahsis etmez. Eski tekli probe enjeksiyonları desteklenir. Bağımsız review tamamlandı;
bulunan UDP descriptor sızıntısı gerçek private CLI testiyle giderildi. Son native CI takibi açık.

- [x] Tek process üzerinden sınırlı toplu bind/close kontrolü.
- [x] Node ve standalone private girişleri, TCP/UDP ve transaction çakışma testleri.
- [x] Bağımsız review; UDP descriptor bulgusu giderildi ve yeniden incelendi.
- [ ] Son düzeltmenin native CI sonuçları; `75a8626` Linux/ARM64 başarılı, Intel iki hata.

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
  "available": [false, true]
}
```

Yanıt boolean'ları istek sırasındadır; böylece aynı port numarasındaki farklı host/protocol
adayları birbirine karışmaz. Bu private helper sözleşmesidir, yeni bir kullanıcı CLI komutu değildir.

#### Not

Rust yalnızca profiler bunun gerçek bottleneck olduğunu gösterirse düşünülmeli.

---

## P3 — Sonraki dönem

### [ ] 19. Resource budgets

**Öncelik güncellemesi (2026-09-09):** Ağır iş eşzamanlılığı ve RAM'e göre kuyruktan iş
başlatma kısmı P1 madde 50'ye taşındı. Bu madde genel process/disk bütçeleri ve platforma
özel sert sınırları kapsar; madde 50 ile aynı kaynak muhasebesini kullanmalı.

Opsiyonel config taslağı (henüz uygulanmadı):

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
- [x] Website/homepage alanını kontrol et.
- [x] Release/installation linklerini görünür hale getir.

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

- [x] Cross-platform badge.
- [x] macOS badge.
- [x] Linux badge.
- [x] Windows badge.
- [x] Latest release badge.
- [x] CI badge.
- [ ] npm version badge.
- [x] License badge.
- [x] JSON/Agent-friendly badge gerekiyorsa korunabilir.

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
- [x] Uninstall dokümantasyonu. — README/CONTRIBUTING `make uninstall` ile state silen
      `make purge`'ü ayırır; macOS state/log ve Linux XDG state/config köklerini, npm kaldırmayı
      ve Windows için önce doctor kökleri/süreç durumu doğrulamasını açıklar. Installer script'leri açık.

---

### [x] 25. Requirements bölümünü macOS-only olmaktan çıkar

**2026-09-10 tamamlandı:** Requirements artık kaynak/npm/standalone gereksinimlerini ayırır: Git, Node24, Bun1.3 ve
SEA için Node24.18.0 pin’i; platform servis gereksinimleri ve deneysel Windows sınırı açık.

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

### [x] 26. Architecture docs'a Platform Layer bölümü ekle

**2026-09-10 tamamlandı:** `docs/02-architecture.md` ve daemon belgesi platform ports, süreç kimliği/ağacı, IPC,
filesystem yolları ve trust farklarını gerçek implementasyonla eşleştirir; bağımsız review tamam.

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

- [x] Platform interface'leri dokümante et.
- [x] Process model farklarını dokümante et.
- [x] IPC farklarını dokümante et.
- [x] Filesystem/path farklarını dokümante et.

---

### [x] 27. Roadmap'i cross-platform olarak yeniden düzenle

**2026-09-10 tamamlandı:** Linux deferred ifadesi kaldırıldı. Mevcut backend/queue/RAM/readiness ile kalan native
kabul, artifact dağıtımı ve gerçek iki-AI RAM ölçümü ayrı gösteriliyor.

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

**2026-09-10:** Manifest zaten `darwin`, `linux`, `win32` içeriyordu; yeniden yazılmadı.
Keywords/description ve README eşlendi; Node>=24 npm runtime, Node24.18.0 SEA build pin’i
ayrıldı. Windows native kabulü madde9’da, npm ilk yayın kanıtı madde38’de açık; metadata
güncellemesi bu platform/yayın kabulü değildir.

Cross-platform hazır olduğunda:

- [x] `os` restriction kaldır veya üç OS'u tanımla.
- [x] keywords içine `linux`, `windows`, `cross-platform` ekle.
- [x] description güncelle.
- [x] npm README platform tablosuyla eşleşsin.
- [x] Node engine requirement tekrar değerlendir.

Not: Windows/Linux desteği tamamlanmadan `os` restriction kaldırılmamalı; yarım destek npm kullanıcılarına kırık paket vermemeli.

---

### [ ] 29. Release workflow'u çoklu OS matrix'e geçir

**2026-09-10 yerel Linux dilimi:** Ortak hedef kataloğu Darwin arm64/x64 ve Linux x64 arşiv
üretimini tanımlar; yayımlanan gerekli hedefler iki Darwin olarak kalır. Linux ELF64 başlığı
en fazla 64 bayt okunur; gerçek FIFO bloklanması review'da bulunup giderildi. Gerçek WTM SEA
arşivlenip çıkarıldı: dört üye, 0755, SHA-256 ve `--version` exit 0. Bu yerel kanıt Linux/Windows
release matrix, signing politikası veya bütün platform kabulü değildir. Ayrıntı:
`docs/development/2026-09-10-distribution-follow-up.md`.

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

- [~] Artifact names stable contract olsun. — mevcut üç yerel hedef ortak katalogda;
      Linux ARM64 ve Windows ZIP ile yayımlama hedeflerinin tamamlanması açık.
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

- [~] standalone binary — Linux x64 yerel ELF arşivi üretildi ve gerçek executable ile
      doğrulandı; GitHub release arşivi ve Linux ARM64 hâlâ açık.
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

- [x] `CONTRIBUTING.md` platform test komutlarını içersin.
- [x] `SECURITY.md` platform-specific security concerns içersin.
- [~] `SUPPORT.md` backend/native/distribution tablosunu içeriyor; minimum OS sürümleri bütün
      hedeflerde kanıtlanmadığı için bu bölüm açıkça bilinmiyor, destek garantisi üretilmedi.

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

### [x] 33. Agent Skill cross-platform hale getir

**2026-09-10 tamamlandı:** Skill platform diagnostic’ini, ortak WTM komutlarını, PowerShell/Git Bash farkını ve
deneysel Windows sınırını anlatıyor. `memory_budget` tablosu tamamlandı; otomatik wakeup veya
tüm terminal komutlarını yakalama iddiası yok. Commander parity ve bağımsız review geçti.

`skills/wtm/SKILL.md` yalnızca POSIX/macOS varsayımlarına dayanmamalı.

- [x] Platform detection rehberi.
- [x] Windows'ta PowerShell/Git Bash farkları.
- [x] Manuel `kill`, `pkill`, `lsof` gibi platform-specific workaround'ları önermemesi.
- [x] Her platformda WTM'nin kendi `status`, `ports`, `ps`, `stop`, `doctor` komutlarını tercih etmesi.
- [x] Skill içindeki install/daemon örneklerini platform-aware yap.

---


# Documentation / consistency checklist

### [x] 34. Kod ve docs parity testi ekle

**Tamamlandı, 2026-09-09.** `scripts/__tests__/cli-docs.test.ts`, aşağıdaki kaynakların
inline komut referanslarını ve fenced komut örneklerini gerçek Commander komut/option
kayıtlarına karşı doğrular. Örnekler çalıştırılmaz; create/remove/start yan etkisi yoktur.
Kontrol, README'deki hatalı `wtm skill --install` kullanımını yakaladı; `wtm skill install`
olarak düzeltildi. Bilinmeyen komut, alt komut ve flag negatif senaryoları mevcut.
Normal `bun test` kapsamında CI'da çalışır. Bu gate komut/flag varlığını denetler;
görevlerin çalışma sonucunu, metin açıklamalarının tamamını veya tüm shell gramerini doğrulamaz.

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
- [x] CLI + daemon conflict — `daemon-lease-conflict.scenario.ts`, hem aynı operasyon (`remove`
      vs `remove`) hem de farklı operasyon (`remove` vs `gc`) için.
- [x] crash during cleanup
- [x] HEAD changes between checks
- [ ] branch changes between checks

### [ ] Remote safety

- [x] stale local remote ref
- [x] deleted remote branch after refresh
- [x] multiple remotes
- [x] allowed refs config — gerçek Git fixture ile production analyze/remove; son selector
      düzeltmesinden sonra symlink/allowed-ref CLI grubu 11/0.
- [x] detached HEAD
- [x] no upstream
- [x] commit persisted in another remote branch

### [ ] Create

- [x] existing branch
- [x] new branch
- [x] conflicting worktree
- [ ] partial multi-repo failure
- [ ] daemon running
- [x] daemon stopped
- [ ] eager prepare
- [ ] lazy prepare

Doğrulama (2026-09-09): `packages/cli/src/__tests__/create.test.ts` 11/11 başarılı.
Daemon açıkken hook ve multi-repo kabul kriterleri bu sonuçla kapatılmadı.

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
- [x] README quick start'ın temiz bir workspace'te baştan sona çalışması
- [x] `sun_path` sınırını aşan uzun `HOME`
- [ ] farklı `HOME`'larda aynı anda iki daemon
- [x] `init` sonrası oluşturulan worktree

---

# Release checklist — v0.2.0

Hedef `v0.2.0` tag'i aşağıdakiler tamamlanmadan çıkarılmamalı:

- [ ] P0 maddelerinin tamamı bitmiş.
- [x] `wtm remove` runtime-aware.
- [x] Cross-process destructive operation lease mevcut.
- [x] Remote freshness semantics net.
- [x] Performance workflow/docs parity sağlanmış. — Madde 4; gerçek platform performance sonucu ayrı gate olarak kalır.
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

**2026-09-09 güncellemesi:** Tamamlanan madde 16/34'ün native CI doğrulamasıyla birlikte
madde 50'nin ilk dilimi (kalıcı kuyruk, sabit ağır iş sınırı, asenkron CLI ve agent skill akışı)
uygulandı; native CI'da ortaya çıkan regresyonlar ve bekleme nedenleri devam dilimidir.
Native süreç kanıtı ve gerçek makine bellek ölçümü alınmadan RAM kriterleri kapatılmaz.
2026-09-10: HTTP readiness, cleanup disk tahmini ve isteğe bağlı RAM kabulü uygulandı.
Bağımsız review tamamlandı; bulunan UDP/log/mount/selector hataları giderildi. Symlink policy
ve platform dokümanları güncellendi. Native Intel/Windows takibi ve gerçek RAM ölçümü açık.
Multi-repo create ve kalan P2/P3 özellikleri sonraki bağımsız geliştirmelerdir.
Bu işler notarization veya diğer yayın hesabı işlerini beklemek zorunda değil.

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
14. shared heavy-job queue + async agent flow (sabit sınır ve tahmini RAM kabulü uygulandı; native takip/gerçek RAM ölçümü açık)
15. readiness/healthcheck
16. local domains
17. GitHub/PR awareness
18. idle runtime
19. TUI/menu bar
```

Bu sıra özellikle destructive safety ve stable release risklerini önce kapatacak şekilde hazırlanmıştır.
