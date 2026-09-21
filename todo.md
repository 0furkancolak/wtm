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

### [x] 2. Cross-process repository operation locking ekle

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
- [x] `remove`, `gc`, destructive cleanup ve ileride `repair` gibi operasyonlarda aynı mekanizmayı
      kullan. — `remove` (`remove-worktree.ts`) ve `gc --apply` (`resources/gc.ts`) ikisi de
      `withRepositoryOperationLease`'i kullanıyor ve artık **birbirlerini de** dışlıyorlar
      (aşağıdaki kabul kriterine bak); `repair` diye ayrı bir komut henüz yok, o yüzden hâlâ
      implement edilmemiş — bu satır bilerek açık kalıyor. `RepositoryOperation` tipi zaten
      `'remove' | 'gc' | 'repair'`, ve genişletilmiş conflict kontrolü satır bazlı değil
      repository bazlı olduğu için `repair` komutu yazıldığı gün ek bir değişiklik gerektirmeden
      doğru davranacak.
      **2026-09-16 kararı (K1):** `repair` komutu v0.2.0 kapsamı dışında; madde mevcut
      `remove`/`gc` kapsamıyla kapatıldı. `repair` yazılırsa aynı lease'i kullanması yeterli.
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

- ~~Performance testlerini "release gate" olarak tanımlayan dokümantasyonu değiştir.~~ (seçilmedi)
- ~~Bunları yalnızca monitoring/report olarak adlandır.~~ (seçilmedi)

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
- **M2, düzeltildi (2026-09-20, W3-4).** `private-directory.ts`'teki her `lstat`/`realpath`/`open`
  `ENOENT` dışındaki her şeyi kodsuz sınıfa yazıyordu, yani supervised bir daemon on saniyede bir
  yeniden deniyordu. `ENOTDIR` (yolun bir bileşeni dizin değil, dosya) ve `ELOOP` (yol bir symlink
  döngüsünden geçiyor) o sınıfa ait değil: ikisi de bir insan bir şeyi değiştirene kadar doğru
  kalır — dosyanın symlink ya da başkasının olması için bu dosyanın zaten kullandığı ölçüt. Artık
  `WTM_PRIVATE_DIRECTORY_UNSAFE` taşıyorlar; diğer bütün errno'lar kodsuz kalıyor, yani geç mount
  edilen bir birim hâlâ yeniden deneniyor.
- **M3, düzeltildi (2026-09-20, W3-4).** Port'un yüklemleri fail-closed, yani `false` hem "cevap
  hayır" hem "okunacak bir cevap yoktu" demek. POSIX'te yalnızca birincisi var; Windows'ta cevaplar
  `powershell.exe`'den geliyor, yani ölen, zaman aşımına uğrayan ya da yüklü bir koşucuyu kaybeden
  bir sorgu ikincisini üretiyor — ve `assertPrivateDirectory` bunu "belongs to another user" diye
  okuyup supervised daemon'ı kalıcı olarak durduruyordu. `FileTrustPolicy`'ye isteğe bağlı
  `ownershipReadable(path)` eklendi; yalnızca *zaten üretilmiş* bir reddi sınıflandırmak için
  soruluyor, güvenlik kararı vermiyor. Yokluğu POSIX cevabı, dolayısıyla iki yeşil platformda
  hiçbir şey değişmiyor. `docs/18` her iki sınıf değişikliğini de yazıyor.

**Doğrulama (throwaway HOME'da, supervised `daemon serve`):**

- (A) `~/Library` 755: exit 0, `WTM_PRIVATE_DIRECTORY_UNSAFE`, `chmod 700` önerisi,
  `permanent:true`.
- (B) Veri dizini symlink: exit 0, aynı kod.
- (C) Servis ayaktayken elle `serve`: exit 1, "already in use". `daemon-status.json` ilk daemon'ın
  `running` kaydını ve pid'ini koruyor.

---

### [x] 52. `wtm doctor`, kayıtlı workspace yokken daemon'ın neden kalkmadığını söylemiyor

45. maddenin final review'ında bulundu (T8). Kayıtlı hiçbir workspace yokken `collect()` herhangi
bir veri kaynağı çalışmadan `WTM_NOT_INITIALIZED` ile duruyor; dolayısıyla hiç `wtm init`
çalıştırmamış taze bir kurulumda `wtm doctor` daemon'ın neden ayakta olmadığını söylemiyor.
`wtm daemon install` bunu zaten bildiriyor, bu yüzden öncelik düşük.

#### Yapılacaklar

- [x] Kayıtlı workspace olmayan bir makinede de `daemon-status.json`'ı okuyup nedeni yüzeye
      çıkaran bir kontrol ekle; `WTM_NOT_INITIALIZED` erken dönüşü bunun önüne geçmesin.

#### Kabul kriterleri

- [x] Hiç `wtm init` çalıştırılmamış bir makinede `wtm doctor`, daemon kayıtlı bir başarısızlıkla
      duruyorsa bunu ve nedenini raporluyor.

**Not (2026-09-11):** Sorun iki katmanlıydı. `collect()` erken dönüyordu, ama daha önemlisi
`wtm init` hiç çalışmamış makinede state DB yok. Bu durumda doctor boş veri kaynağına düşüyor ve
sorulacak hiçbir şey kalmıyordu. Daemon'a erişim yoklaması ile `daemon-status.json` okuması store
gerektirmediği için `daemon-startup-diagnostic.ts`'e taşındı. Store'lu kaynak da DB'siz kaynak da
bunu kullanıyor. Kararlar:

- `WTM_NOT_INITIALIZED` tek hata olarak kalıyor; kayıtlı başarısızlık yanına **warning** olarak
  ekleniyor. Envelope'un exit kodu en kötü hatanın sınıfı olduğu için ikinci bir hata exit 2'yi
  4'e çevirebilirdi. Kayıtlı makinede aynı kayıt bir bulgu ve exit kodunu etkilemiyor, burada da
  etkilememeli.
- Uyarı daemon'ın kendi kodunu (tanımlı bir kod değilse `WTM_DAEMON_UNAVAILABLE`), ne zamandır
  ve kaç kez başarısız olduğunu ve varsa remediation'ı taşıyor.
- Yalnızca `doctor`, yalnızca yerel modda ve kayıtlı workspace hiç yokken soruyor. Bilinmeyen bir
  selector ayrı bir hata ve kendi çaresi var. Kayıtlı makinede aynı bilgi zaten `registration`
  bulgusunda.
- Açık bırakılan: `wtm doctor --global` kayıtlı workspace yokken hâlâ boş bir başarı döndürüyor ve
  daemon hakkında bir şey söylemiyor. Kabul kriteri yerel `doctor`'ı kapsıyor.

Bağımsız final review: 0 kritik, 1 önemli, 5 küçük bulgu.
- I1: Uyarının `context`'i, docs/18'de `WTM_PRIVATE_DIRECTORY_UNSAFE` için yazılı `path`/`reason`
  alanlarını taşımıyordu. Uyarının biçimi docs/18'e yazılarak düzeltildi.
- M1: docs/04, selector ve `--global` durumlarını da kapsıyormuş gibi yazıyordu. Metin daraltıldı.
- M2: Store'lu kaynağın yeni metodu için test yoktu. DB açık ama workspace'siz senaryo için test
  eklendi.
- M3: Kayıtlı uzun bir mesaj, 1024 karakter sınırında çare cümlesini kesiyordu. Kayıtlı mesaj
  600 karaktere kısaltılıyor.
- ~~Açık kalanlar:~~
  - **M4, düzeltildi (2026-09-18, W2-4).** Kayıt artık tek bir yerden türetiliyor:
    `hostDaemonStatusPath`, `ServicePaths.logRoot` üzerinden. `daemon serve` kaydı zaten oraya
    yazıyordu; `doctor` ise `PlatformRuntime.paths.logRoot`'tan ikinci bir türetmeyle okuyordu. İki
    çözümleyici bugün aynı yolu veriyor, sessizliğin nedeni de bu: ayrıştıkları gün `doctor`,
    daemon'ı kalkmayan makinede "kayıt yok" derdi. `createStateDiagnosticDataSource` artık
    `daemonServicePaths` seam'ini alıyor, yani testin daemon'ı yönlendirdiği throwaway `HOME`'u
    okuyan da aynı yer.
  - **M5, düzeltildi (2026-09-18, W2-4).** Uyarıyı tetikleyen artık koşulun kendisi: yerel
    `doctor`, selector yok ve registry hiçbir şey listelemedi. `collect` bunu `CollectOutcome` ile
    dışarı veriyor; envelope'un taşıdığı `WTM_NOT_INITIALIZED` metni okunmuyor. Kayıtlı bir
    workspace hakkında `WTM_NOT_INITIALIZED` döndüren bir veri kaynağı artık kaydı ikinci kez
    almıyor — o makinede aynı bilgi zaten `registration` bulgusunda.

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

**2026-09-13 ölçümü:** Tarif, tek bir gerçek makinede (macOS arm64, 16 GiB) ilk kez uygulandı:
`docs/development/2026-09-13-heavy-job-memory-results.md`. Kurulum:
- geçici `HOME`, ayrı daemon ve build edilmiş CLI;
- iki bağımsız klon; görev olarak her birinde `bun run typecheck`;
- kuyruksuz, limit 1 ve RAM kabulü modları, her biri 3 kez.

Sonuçlar:
- İki task ağacının tepe RSS toplamı kuyruksuzda 1184 MiB, limit 1'de 655 MiB, RAM kabulünde
  634 MiB (medyan).
- Toplam süre 7,6 sn'den yaklaşık 15–16 sn'ye çıkıyor.
- Daemon iş sırasında yaklaşık 25 MiB ekliyor.
- Kabul yaklaşık 0,3 sn sürüyor. Bekleme nedeni limit 1'de `concurrency`, RAM kabulünde
  `memory_budget` olarak doğru raporlanıyor.
- 12 işin hepsi `SUCCEEDED`, exit code 0 ve kaynak `UNCHANGED` ile bitti.
- Claude süreçlerinin RSS'i (3,4–3,6 GiB) moddan etkilenmedi.
- Bellek baskısı ve swap hiç oluşmadı. Bu yüzden kuyruğun baskıyı veya swap'ı azalttığı bu
  ölçümden çıkarılamaz.

Açık kalanlar: gerçek iki AI oturumu, daha ağır bir görev ve Linux/Windows ölçümleri.

Ayrıca ölçüm sırasında bulunan bir sınır (50c) **giderildi.** Kaynaktan `node --import tsx` ile
başlatılan daemon, kuyruktaki işi `RUNTIME_START_FAILED` ile düşürüyordu: özel runner modları için
yeniden çağrılan giriş noktası hiçbir yükleyici almıyordu. Yeniden çağırma artık tek bir yerde,
`packages/platform/src/runtime-invocation.ts` içindeki `selfRuntimeInvocation()` ile kuruluyor;
`.ts` girişli bir süreç kendini `--import <source hooks>` ile yeniden çağırıyor
(`packages/platform/src/source-runtime-hooks.ts`, uzantısız göreli importları iş parçacığı içinde
çözer, tip soyma Node'a bırakılır). Ebeveynin `process.execArgv` girdilerinin hiçbiri
devralınmaz; gerekçesi (özellikle `--inspect*` port çakışması ve tsx'in anchor'ın süreç grubunda
bırakacağı `esbuild --service` çocuğu) `selfRuntimeInvocation()` yorumunda yazılıdır. SEA yolu
değişmedi. Kanıt: `packages/cli/src/__tests__/source-daemon-jobs.test.ts` — "a daemon started from
source with node --import tsx runs a queued job to success" (enjeksiyon yok, uçtan uca);
ayrıca `packages/cli/src/__tests__/source-runtime-invocation.test.ts` ve
`packages/platform/src/__tests__/runtime-invocation.test.ts`. `developmentRuntimeInvocation()`
mevcut testlerde olduğu gibi bırakıldı. Ölçümün kendisi build ile yapılmıştı; bu değişmedi.

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
- [x] Süreç ağacının bellek ölçüm maliyetini sınırla. RSS toplamını paylaşılan sayfalar nedeniyle
      kesin fiziksel RAM tüketimi sayma. Tahmine dayalı kabul kontrolü ile işletim sistemi
      tarafından zorlanan sert bellek sınırını ayır; platform desteğini doğrulamadan vaat etme.
      Genel disk/process bütçeleri madde 19'da kalsın; iki ayrı scheduler oluşturma. —
      **2026-09-21 (W8-4 / 50b):** kod zaten hiç süreç ağacı/RSS taraması yapmıyordu
      (`job-memory.ts`, yalnızca host `available`/`constrained` belleği); eksik olan bunun neden
      böyle olduğunun (maliyet + paylaşılan sayfa nedeniyle RSS toplamının yanıltıcılığı) ve
      kabul ile OS-zorlamalı sert limit arasındaki farkın belgelenmesiydi.
      `docs/07-process-port-runtime.md`'ye "Heavy job memory admission" bölümü eklendi,
      `SKILL.md` ve `heavy-job-queue.ts`'e çapraz referanslı birer not eklendi. Madde 19 ile
      paylaşılan muhasebe/ayrı scheduler yok ilkesi zaten K7'de teyit edilmişti, burada tekrar
      belgelendi. Kod davranışı değişmedi; bu saf dokümantasyon kapanışı.

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
- [x] Aynı görev setiyle kuyruk öncesi/sonrası tepe bellek, bellek baskısı/swap, toplam süre
      ve WTM daemon ek maliyeti ölçülür. Claude'un kendi bellek tüketimindeki değişim ayrıca
      ayrıştırılır; ölçüm yapılmadan belirli bir RAM tasarrufu oranı vaat edilmez.
      2026-09-13, tek makine (macOS arm64, 16 GiB) ve tek görev (`bun run typecheck`) için:
      `docs/development/2026-09-13-heavy-job-memory-results.md`. Tasarruf oranı yine vaat
      edilmiyor. Baskı/swap bu makinede hiç oluşmadığı için bu kısım "değişmedi" olarak
      ölçüldü, azalma olarak değil.

---

### [x] 6. `wtm create` ekle

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

**Kapandı (2026-09-13).** Tek repo create 2026-09-07'de, çok repolu create ve kurtarma
2026-09-13'te: spec `docs/superpowers/specs/2026-09-13-multi-repo-create-design.md`, plan
`docs/superpowers/plans/2026-09-13-multi-repo-create.md`. Feature kimliği mevcut "aynı workspace,
aynı branch" gruplamasının kalıcı kaydı; yarım kalan oluşturma silinmez, `--resume` ile tamamlanır.
Kapsam dışı bırakılanlar: `--abandon`, daemon açılışında otomatik tamamlama, `wtm doctor` bulgusu,
feature düzeyinde olay, repolar arasında farklı branch adları, tek repolu create için lease.

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
- [x] Multi-repo branch alignment. — `--repos`; spec
      `docs/superpowers/specs/2026-09-13-multi-repo-create-design.md`.
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
- [x] Partial multi-repo creation rollback/recovery. — journal + `--resume`; aynı spec, §4.

#### Kabul kriterleri

- [x] Tek repo create deterministic. — hesaplanmış yol, çağıranın dizininden bağımsız başlangıç
      noktası, ve Git yazmadan önce verilen her ret. Yeni dal **main worktree'nin HEAD'inden**
      başlıyor, kullanıcının içinde durduğu worktree'den değil: "starts a new branch at the main
      worktree HEAD" hem core hem CLI seviyesinde bunu doğruluyor.
- [x] Multi-repo create aynı feature identity altında çalışıyor. —
      `packages/cli/src/__tests__/create-feature.test.ts`.
- [x] Yarım kalan creation güvenli biçimde recover ediliyor. —
      `packages/cli/src/__tests__/create-feature-recovery.test.ts` ve
      `packages/core/src/analysis/__tests__/create-feature-recovery.test.ts`.

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
- [x] ARM64 + x64 binary build pipeline. — x64 tamam (`binary:verify` ubuntu bacağında yeşil,
      `dist/sea/wtm … linux-x64`); **2026-09-16:** arm64 de CI'da (`ubuntu-24.04-arm`) derleniyor ve
      `binary:verify` geçiyor (`360a7da` / `34947190062`). Release'te Linux arşivlerinin
      yayınlanması madde 29'da ayrıca izleniyor.

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
      2026-09-16 (W1-1): main'deki son tamamlanmış koşu `360a7da` / `34947190062` — darwin arm64,
      linux x64 ve linux arm64 yeşil, darwin x64 test adımı **kırmızı** (asılma değil, 11.5 dk'da
      iki gerçek hata; ikisi de `process-supervisor.test.ts`): "RUNNING transition failure kills the
      group" testinde `descendantMarker` ENOENT, ve `restart` içinde `#stopLocked` `EPERM` ile
      `RUNTIME_STOP_FAILED`. Her ikisinin kökü bu birimde düzeltildi: yarışı kaldıran enjekte
      edilmiş RUNNING hatası ve `EPERM`'i errno yerine gözleme bırakan sinyal yolu. (Ayrı bir
      kusur: darwin **arm64**'teki F1 kararsızlığı — run `34947174999` — `nlink <= 1` güven
      kuralıyla düzeltildi; x64'teki iki hatayla ilgisi yok.) Ancak henüz bu düzeltmeleri içeren
      **yeşil bir darwin x64 koşusu yok**; kanıt gelene kadar `[~]`.
- [x] Linux x64 CI green. — `75a8626` / `34457543774`: test 1627/0, e2e 3/0, binary 10/0;
      lint/typecheck/build/package geçti. Takip yamalarının native kanıtı ayrıca izlenir.
- [x] Linux arm64 build doğrulanıyor. — `360a7da` / `34947190062` `ubuntu-24.04-arm` bacağı:
      lint, typecheck, test, e2e, build, `package:verify`, `binary:verify` ve Linux arşiv doğrulaması yeşil.
- [ ] Windows x64 CI green. — **2026-09-10 takip yeniden başladı.** `75a8626` koşusunda
      1327 pass / 115 fail / 200 skip ve bir testler-arası error; sonraki gate'ler çalışmadı.
      Native log, anchor'da yanlış POSIX 0700 kontrolünü somut olarak gösteriyor; SID/ACL
      capability düzeltmesi geliştiriliyor. Custom state-root pipe adresi ve fixture Windows
      home izolasyonu düzeltildi. Gerçek native sonuç gelmeden bu madde kapanmaz.
      Önceki incelemeler tarihsel notlarında korunur; güncel kayıt
      `docs/development/2026-09-10-windows-follow-up.md`.
      **2026-09-14:** win32 leg'i geçici olarak bilgi amaçlı yapıldı (`continue-on-error`, 25 dk).
      `34873813789` koşusunda 80 native fail vardı ve birkaç test 300 sn'lik test sınırını bekliyordu.
      Bu yüzden her koşu 60 dk'da kesilip kırmızı bitiyordu. Bu madde kapanınca `continue-on-error`
      kaldırılmalı ve leg yeniden zorunlu olmalı.
      **2026-09-16:** bu madde üzerinde çalışan sonraki Windows artımları (W2-W5) için `ci.yml`'e
      `workflow_dispatch.inputs.win32_test_filter` eklendi: `gh workflow run CI --ref <branch> -f
      win32_test_filter="..."` ile hedeflenen test dosyalarını sadece win32 leg'inde, diğer dört
      leg'i ve e2e/build/package/binary adımlarını atlayarak 25 dakikalık sınır içinde yeşile
      kanıtlamak mümkün. Ayrıntı: `docs/12-open-source-distribution.md`.
      **2026-09-16 (W2-2 / 9c):** win32 leg'inin en büyük tek gideri olan "her ACL çağrısında
      soğuk `powershell.exe` başlatma" kaldırıldı: `packages/platform/src/trust/`
      `windows-powershell-session.ts` tek bir uzun ömürlü `powershell.exe -Command -` oturumunu
      paylaşıyor; güven cevabı aynı (oturum ölümü/timeout reddir, asla "güvenli" değil), yol
      artık script metnine değil base64 veriye gidiyor, ve istek/kuyruk/ömür/boşta/çıktı sınırları
      açık. `ci.yml`'deki 300000 ms win32 test timeout'u bu maddeyle birlikte tekrar
      değerlendirilebilir. `logs.test.ts`'in win32 süresi CI kanıtı bekliyor.
      **2026-09-16 (W2-1 / 9a):** `client.test.ts`'in iki testinin win32'de 300 sn beklemesi
      kaldırıldı. Kanıt (`34873813789` / `34947190062` logları): test gövdesi ~1.03 sn'de
      başarısız oluyordu; 300 sn'yi `afterEach` kancası yakıyordu (Bun'ın kendi satırı:
      "a beforeEach/afterEach hook timed out for this test"). Kök neden `DaemonClient`'ın taşıma
      katmanı üzerindeki sınırsız beklemeleriydi: `#connect()` yalnızca `connect`/`error`
      dinliyordu (hatasız `close` hiçbir şeyi çözmüyordu, ve hiç bağlanma süresi sınırı yoktu) ve
      `close()` `destroy()` sonrası `'close'`'u sonsuza kadar bekliyordu. Üçü de sınırlandı
      (`transportTimeoutMs`, varsayılan 5000 ms, `requestTimeoutMs`'ten türetilmiyor); ayrıca
      hata enjeksiyonu için soket sınırında `connect` dikişi eklendi. Sınırsız bekleme üretim
      hatasıydı: wedge olmuş bir named pipe'ta `wtm` hiç çıkamazdı.
      **Kalıntı (9a kapanmadı, sahibi 9b):** o ~1 sn'lik gövde hatası gerçek bir win32 taşıma
      hatasıdır, hâlâ açıklanmış değildir ve win32'de artık bilerek kapsam dışıdır. Kesin ifadesi:
      "aynı named pipe adresine ikinci bağlantı hiç karşılanmıyor" **değil** —
      `readiness-transport.test.ts > scope` win32'de geçiyor (koşu 1, 271 ms) ve aynı pipe'ta ikinci
      bir *eşzamanlı* istemci tutuyor. Hata özellikle **ilk pipe örneği frame'in ortasında
      yıkıldıktan sonra yeniden bağlanma** durumudur: `connect` geliyor, istek yazılıyor, 1 sn
      içinde cevap gelmiyor. İstemci aklandı (aynı iki vaka betiklenmiş taşımada geçiyor; merge
      base'in gerçek soket testleri yeni istemciye karşı POSIX'te değişmeden geçiyor). Gerçek soket
      reconnect testleri `client.test.ts`'de `test.skipIf(process.platform === 'win32')` ile
      duruyor, yani diğer dört bacak reconnect'i kanıtlamaya devam ediyor. 9b'nin bildirilen kod
      alanı `packages/platform/src/ipc/*` olduğu için bu kalıntı 9b'nin dosya listesinden
      kendiliğinden gelmez; ayrıntı ve devralma notu
      `docs/superpowers/plans/2026-09-16-w2-win32-failure-clusters.md`'nin 9a bölümünde.
      **2026-09-18 (W2-3 / 9f):** `docs/superpowers/plans/2026-09-16-w2-win32-failure-clusters.md`
      §9f'te tarif edilen beş kök nedene de birer düzeltme yazıldı; hepsi mevcut
      port/enjeksiyon dikişinden geçerek ve
      hiçbiri `@wtm/core`'a ya da testlere bir `process.platform` dalı eklemeden. Tek istisna
      `select.ts`: madde (3) bu dosyaya ikinci bir `process.platform` okuması ekliyor
      (`hostFileTrustPolicy` içinde), yani backend seçen tek yerin içine — dışına değil.
      (1) `@wtm/core`'un POSIX-only
      `defaultCoreFileTrustPolicy`'sine düşen üç çağrı yeri — `removal-coordinator.ts`'in
      ephemeral temizliği, `prepareRuntimeResources` ve `gc.test.ts`'in kendi fixture'ı —
      composition root'un zaten seçtiği politikayı alıyor; Windows'ta o fallback hem
      `currentIdentityAvailable()` hem de dizinlerin uydurma `0o777` modu yüzünden her şeyi
      reddediyordu. (2) `runAdapterCommand` seçilen politikayı `trustRepositoryAdapter`'a
      taşımıyordu; `adapter.scenario.ts` hiç seçmiyordu. (3) `selectPlatformRuntime`
      `fileTrust`'ı artık **host'tan** seçiyor: diğer bütün port'lar bir hedef platformu
      tarif eder, `fileTrust` ise bu sürecin gerçekten baktığı dosya sistemini okur.
      (4) `daemon-status.json` 0o600 iddiası POSIX'e özgüydü; üretim kodu değişmedi, karar ve
      reddedilen ACL alternatifi commit mesajında yazılı. (5) `reconcile-fallback`'in
      `chmod 0o500` öncülü Administrator'a da root'a da bir şey yasaklamıyordu.
      **Windows kanıtı (PR #24, run `35340823569`, win32 job `105586076666`): 9f kapanmadı.**
      Bacak 25 dakikalık sınıra takılmadan önce 239 test dosyasının 158'ine ulaştı — kümeleme
      dokümanının yazıldığı iki koşu 107 ve 63'te kesilmişti — ve W2-3 listesindeki bütün CLI ve
      `core/resources` dosyalarını ölçtü. Ölçülmeyenler: `daemon/resource-preparation-trust`
      (174), `daemon/runtime-factory` (177), `platform/select` (190) hiç sıraya gelmedi,
      `cli/daemon-status` (20) ise okunabilen log penceresinden önce koştu.
      Windows'ta kapanan: `remove-runtime`'ın `deletes the ephemeral resources it materialized`
      testi ve bu dalın eklediği `authorizes the ephemeral cleanup against the injected trust
      policy` testi geçiyor (dosyadaki kalan iki hata kümeleme dokümanının 9g'ye yazdığı shim
      testleri); `reconcile-fallback` tamamen yeşil; `gc.test.ts`'in üç `RESOURCE_PATH_DENIED`
      hatası gitti; `adapter.test.ts`'in `creates the missing private WTM state parent` testi
      geçiyor.
      **2026-09-21 (W4-2 / 9g):** kümenin dört hatasının tamamı tek bir kök nedene sahip:
      `refresh-remotes.test.ts`, `main.test.ts`'in seçicisiz analiz testi, `remove-runtime.test.ts`
      ve `ci-watch-scenario.test.ts` hepsi bir sahte `git`/`gh`'yi `PATH`'e ekleyip çıplak adla
      (`spawn('git')`) çağrılmasını bekliyor. `writeExecutableFixture` win32'de `git.cjs` artı bir
      `git.cmd` trambolini yazıyor — ama libuv'nin `search_path`'i çıplak bir ada yalnızca
      `.com`/`.exe` ekliyor, `PATHEXT` ne derse desin `.cmd` asla değil. Yani `spawn('git')`
      `git.cmd`'yi hiç görmüyor; `PATH`'te daha ileride duran gerçek `git.exe`'yi buluyor ya da
      `ENOENT` veriyor — testlerin sıfır sayaç raporlamasının nedeni bu, hata değil.
      `packages/testkit/src/executable-fixture.ts`'in kendi doküman yorumu bunu zaten söylüyor;
      fixture'lar Windows-doğru yapılmıştı, `PATH` gölgelemesine dayanan çağıranlar değil.
      Düzeltme gerçek bir Windows doğruluk kusuru olarak ele alındı, yalnızca testler için değil:
      `@wtm/platform`'a `executablePathResolverFor(platform)` eklendi — win32'de `PATH` içinde
      sırayla, her girişte `PATHEXT` sırasıyla arayan, darwin/linux'ta kimlik (`execvp` zaten
      yapıyor) dönen bir çözücü. `@wtm/core`'un `git-runner.ts`'i artık `git`'i sabit
      yazmıyor: `useGitExecutableResolver` adında enjekte edilebilir bir modül-seviyesi çözücü
      var (core kendi platformunu bilemez, spec D1), varsayılanı kimlik. `cli`'nin
      `hostPlatformRuntime()`'ı ve `daemon`'ın `createProductionDaemon`'ı platformu seçtikleri
      anda bunu kuruyor; `createGhRunner`'ın `executable`'ı da aynı çözücüden geçiyor.
      POSIX'te çözücü kimlik olduğu için darwin/linux'ta hiçbir davranış değişmedi — dört test
      dosyası da Linux'ta hâlâ yeşil, tam kapı temiz.
      Kanıt durumu: kök neden libuv'nin belgelenmiş arama sırasından ve gözlemlenen hataların tam
      şeklinden çıkarıldı, Windows'ta doğrulanmadı. Hedefli bir `win32_test_filter` koşusu
      gerekiyor.
      Kapanmayan: `ci-watch-scenario.test.ts`, dosyadaki kalan `daemon/main.test.ts`'in ACL/izin
      kümesiyle paylaştığı hata (9c/9g belirsizliği, kümeleme dokümanında zaten düşük güvenle
      işaretli) bu değişikliğin kapsamı dışında.
      Kapanmayan: adapter trust dörtlüsü — `adapter.test.ts`'in iki SQLite testi,
      `main.test.ts`'in `wires adapter trust through the CLI` testi ve bu dalın eklediği
      `trusts an adapter executable through the injected policy` testi. **Kök neden enjeksiyon
      tesisatı değil**: `plan/adapter-trust.ts`'in `assertSafeAdapterFile` fonksiyonu, üç
      `fileTrust` sorusunun altında ham bir `(stat.mode & 0o111) === 0` kontrolü tutuyor.
      Windows'ta çalıştırma biti yok ve Node normal bir dosyanın `mode`'unu `0o666` uyduruyor
      (aynı mekanizma (4)'teki `0o600` beklentisine `0o666` döndüren mekanizmadır), yani bu
      kontrol hangi politika enjekte edilirse edilsin her adapter yürütülebilirini reddediyor.
      `verifyTrustedRepositoryAdapter` ve `openTrustedAdapterDescriptor` de aynı fonksiyondan
      geçiyor. Çalıştırılabilirlik bir platform sorusudur ve `FileTrustPolicy`'nin taşımadığı
      tek platform sorusudur; düzeltmesi port'a bir predicate eklemektir.
      Ayrıca `gc.test.ts`'in `dry-run by default` testi hâlâ kırmızı ama artık başka bir hatayla:
      `resources/gc.ts`'in `assertSandboxIdentity`'sinden gelen `RESOURCE_CLEANUP_FAILED`.
      `core/resources`'ın `guard.test.ts` (3) ve `materializer.test.ts` (2) hataları regresyon
      değil: kümeleme dokümanı hiçbir `core/src/*/__tests__` dizininin win32'de çıktı
      üretmediğini kaydediyor, bunlar ilk kez ölçüldü.
      Kalan iş ayrı bir birimde toplanır; `win32_test_filter` değeri plan dosyasındaki W2-3
      listesidir. Bu dalın eklediği `trusts an adapter executable through the injected policy`
      testinin kabul eden yarısı hiçbir politika enjekte etmiyor, o yarı da o birimde
      `adapter.scenario.ts` gibi host politikasını almalı.
      **2026-09-20 (W3-1 / 9b):** kümeleme dokümanının 9b bölümündeki üç somut kusur kapatıldı,
      hiçbiri bir Windows ölçümüne değil Node'un kendi belgelenmiş semantiğine dayanarak.
      (1) `net.Server.close()` mevcut bağlantıları *korur* ve geri çağrısı ancak hepsi
      sonlandığında koşar; POSIX'te bu iki kez maskeleniyor (`UnixIpcServer` kendi soketlerini
      önce yok ediyor, ve yayımlanan ad dinleyiciden bağımsız silinebilen bir dosya girdisi),
      Windows'ta ise hiçbiri yok — named pipe'ın silinecek girdisi olmadığı için `unpublish`
      *kapanmanın kendisidir*. `createWindowsIpcPublisher` artık yayımladığı sunucunun kabul
      ettiği bağlantıları kendisi kaydediyor ve `unpublish`'te yok ediyor. Aynı boşluk
      `ipc-address.test.ts`'in 300 sn'lik `a real fixture endpoint answers, closes, and can be
      bound again at the same address` testinin de şekli: çıplak `createServer` hiçbir şey
      izlemiyordu. `@wtm/testkit`'e `createTrackedIpcServer` eklendi. İki düzeltmenin de
      ayırt edici regresyon testi var (düzeltme geri alındığında Linux'ta zaman aşımına uğruyor),
      ve publisher testi `fixtureIpcAddress` üzerinden bağlandığı için win32 bacağında gerçek bir
      named pipe'a bağlanıyor.
      (2) `lstat(socketPath).isSocket()` ile "daemon ayağa kalktı mı" beklemesi Windows'ta
      hiçbir zaman doğru olamaz: named pipe bir dosya sistemi girdisi değil. `daemon.test.ts`'in
      `wires serve to the production runtime factory...` testi ve
      `source-daemon-jobs.scenario.ts` artık `@wtm/testkit`'in yeni `ipcEndpointReachable`
      yoklamasını kullanıyor. Bağlantı, dosya girdisinden güçlü bir gözlem de: bağlanmış bir
      soket dosyası kabul eden bir dinleyiciden önce de var olabilir.
      (3) `an over-long HOME refuses serve...` testinin `fixture did not land one byte past the
      socket path limit` hatası bir üretim kusuru değil: `windowsPlatformPaths` pipe adını
      `dataRoot`'un özetinden türetiyor, yani her HOME aynı uzunlukta bir ad yayımlıyor ve
      256 karakterlik sınır HOME üzerinden erişilemez. Fixture artık bunu platform adıyla değil
      türetmenin kendisiyle (`addressGrowsWithHome`) karara bağlıyor ve erişilemez olduğu
      hostlarda sınırın neden erişilemez olduğunu ölçüyor.
      9b'nin geri kalanı (`runtime-factory`, `create-daemon-running`, `readiness-workflow`,
      `full-workflow` senaryoları) 9d ve 9e'ye bağlı; kümeleme dokümanı da bunları 9b'nin tek
      başına kanıtı saymıyor. Windows kanıtı `win32_test_filter` ile ayrıca alınacak.
      **2026-09-20 (W3-2 / 9d):** 9d'nin en büyük kümesi — `process-supervisor.test.ts`'in
      24 testi, hepsi `ManagedProcessError: Managed task could not be started.` — için tek bir
      kök neden adayı bulundu ve düzeltildi; iddia bir Windows ölçümüne değil, deponun kendi
      sayılarının birbiriyle çelişmesine dayanıyor. Anchor'ın kimlik okuması Windows'ta bir
      `powershell.exe` başlatmaktır ve anchor'daki kopyası **5000 ms** ile sınırlıydı. Bu sayı
      `trust/windows-powershell.ts`'te 5 sn'den 15 sn'ye çıkarılmıştı (soğuk powershell ~1.6 sn
      artı gerçek CI yükü) ve `process/windows.ts`'te gerçek bir windows-latest bacağı 5 sn'de
      `taskkill.exe ETIMEDOUT` ürettiği için 15 sn'ydi; anchor bu iki düzeltmenin ikisini de
      kaçıran üçüncü kopyaydı. Kendi sınırını aşan bir anchor `READY` bildiremez, supervisor
      bunu `ANCHOR_HANDSHAKE_INVALID` okur, çağıran ise `RUNTIME_START_FAILED` görür.
      Sayı artık tek bir yerde: `platform/src/process/observation-budget.ts`'in
      `processObservationBudgetFor`. Anchor onu `WTM_ANCHOR_SPEC` üzerinden **söylenir**,
      `platform` alanıyla aynı disiplinde — anchor hiçbir zaman kendi gözlemine sormaz.
      İkinci ve bağlı kusur: supervisor'ın `anchorProtocolTimeoutMs`'i düz **10 sn**'ydi, yani
      içerdiği 15 sn'lik gözlemden *kısa*. Artık platformdan türüyor
      (`gözlem bütçesi + 9 sn`), bu da darwin ve linux'u tam olarak eski 10 sn'de bırakıyor —
      yeşil bacaklar yeniden ayarlanmadı — ve win32'ye kendi işini tutabilecek bir sınır veriyor.
      Eşitsizlik `process-anchor.test.ts`'te teste bağlandı.
      Ayrıca 9d listesindeki üç fixture kusuru: (a) `captureAnchorSpec` anchor yerine
      `/bin/sh -c` koyuyordu, Windows'ta kabuk yok, çocuk hiç koşmuyor ve test var olmayan
      `spec.json`'ı okuyordu — artık `node -e`. (b) `treats a /proc entry it may not read as not
      a member` testinin öncülü ne Windows'ta ne de root'ta kuruluyor; `reconcile-fallback`'in
      zaten kullandığı `isUnprivilegedPosixUser` yüklemi `@wtm/testkit`'e taşındı ve iki dosya da
      onu kullanıyor. Bu, sandbox'ta root altında düşen dört dosyadan birini de kapatıyor.
      (c) `scenario-child.test.ts`'in "SIGTERM'i yok sayan çocuk" fixture'ı Windows'ta var
      olamaz: Node `subprocess.kill()`'i orada hangi sinyal verilirse verilsin koşulsuz
      sonlandırıyor. Beklenti artık platformu söylüyor ve Windows dalında **ters** sonucu
      doğruluyor, yani zayıflatma değil.
      Kapanmayan, Windows ölçümü isteyen üç kalem: `completion-path-identity`'nin
      `generation-churn` modu Windows'ta 3 yerine 5 değiştirme sayıyor (üç denemeli sınırın
      kendisi değil, deneme başına açılış sayısı farklı); `process-supervisor.test.ts`'in
      `delegate to the port the platform seam selected` testinin `toEqual` farkı; ve
      `daemon-restart-recovery`'nin 30 sn'de öldürülen senaryosu. Üçü de tahmine dayalı bir
      düzeltme yazmak yerine kanıt bekliyor.
      **2026-09-20 (W3-3 / 9h):** kümeleme dokümanının 9h bölümündeki iki hatanın ikisi de
      kapatıldı ve biri gerçek bir ürün kusuruydu. `forget.ts`'in `resolveAgainst` fonksiyonu
      seçiciyi yalnızca `/` ile başlıyorsa mutlak sayıyor ve aksi halde kendi `/`'ı ile cwd'ye
      yapıştırıyordu: `C:\projects\repo` `/` ile başlamaz, yani Windows'ta mutlak bir seçici
      göreli okunup `C:\work/C:\projects\repo` oluyordu. Sonuç, `wtm forget <mutlak yol>`'un
      depo dalına hiç ulaşamaması ve sessizce içeren workspace'i emekli etmesi — istenenden
      büyük bir işlem. Artık `node:path`'in `isAbsolute`/`resolve`'u kullanılıyor.
      İkinci yarısı karşılaştırma: `mainRoot === path` bir dizinin birden çok meşru yazılışı
      olan bir hostta doğru testi değil. `@wtm/core/paths`'e `samePath` eklendi; `node:path`'in
      `relative`'i ayırıcıyı normalize ediyor ve büyük/küçük harf kuralını hostun kendisinden
      alıyor (Windows'ta `C:\p\repo` ile `c:\p\repo` aynı, POSIX'te değil). Bilerek
      `realpath` değil: bu çağıranlar dizini çoktan silinmiş olabilecek kayıtları soruyor.
      `forget.test.ts`'in fixture'ı da gerçek bir `mkdtemp` yolunu `path/posix` ile birleştiriyordu,
      yani Windows'ta `…\wtm-forget-x/repo` ile `…\wtm-forget-x\repo` karşılaştırılıyordu;
      birleştirme artık kökün kendi yazılışını izliyor. Hostun kendi yazılışında mutlak ve göreli
      seçici için iki yeni test var.
      `isolated-home.test.ts`'in çocuğu 5 sn'de öldürülüyordu: `runScenario`'nun kendi dokümanı
      `timeoutMs` geçersiz kılmasını yalnızca sınırı ölçen testlere ayırıyor, bu test ise ortam
      kalıtımını ölçüyor. 5 sn soğuk bir Node başlangıcına konmuş bir sınırdı ve yüklü bir
      windows-latest koşucusu onu kaybediyor. Paylaşılan varsayılan kullanılıyor artık.
      9h'nin başlığındaki junction ve reparse point güvenliği için win32 bacağından ölçüm yok:
      iki koşu da `core`'un ilgili dosyalarına hiç ulaşmamıştı. Tahminle kod yazılmadı.
      **2026-09-21 (W4-1 / 9e):** 9e kümesinin yedi hatasının tamamı tek bir şekildeydi —
      senaryo çocuğu 30 000 ms'de öldürüldü (`heavy-job-native-lifecycle` 4,
      `jobs-workflow` 2, `idle-daemon` 1). Öldüren sınır senaryonun kendi sınırı değildi:
      `runScenario`'nun varsayılanı 120 sn ve kendi dokümanı bunu "bir askıyı bitirmek için,
      bir şey ölçmek için değil" diye tanımlıyor. Üç dosya da bunun altında bir test-başı
      sınır taşıyordu, biri ayrıca `timeoutMs`'i 30 sn'ye indiriyordu. Test-başı sınır
      bloke eden bir `spawnSync`'i kesemez; yalnızca sonradan rapor eder — ve komutu
      adlandırmaz. Yani üçü de POSIX ölçüsünde bir sayıyı, tek bir süreç gözleminin 15 sn
      bütçelendiği bir platformda ölçüm olarak kullanıyordu. `@wtm/testkit` artık
      `scenarioTestTimeoutMs()` veriyor ve üç dosya da onu kullanıyor; eşitsizliği kendi
      testi sabitliyor.
      İkinci yarısı ürün kodunda: `waitForGroupAbsent`'in tabanı düz `2_000` ms'ti — yazıldığı
      platformlarda bir `ps` artı pay, win32'de *tek* bir gözlemden az. Çağıran 500 ms sabır
      istediğinde döngü ilk gözlemini yapar, o gözlemin maliyetiyle süresi çoktan dolmuş olur
      ve daha yeni bakmaya başladığı bir grup için `alive` der; durdurma
      `GROUP_REMAINED_ALIVE`, iş `PROCESS_TREE_STILL_RUNNING` olur ve hiç terminale geçmez.
      Taban artık `groupAbsenceTimeoutMs(platform)` = gözlem bütçesi + 1 000 ms: darwin ve
      linux tam olarak 2 000 ms'de kalıyor (yeşil bacaklar yeniden ayarlanmadı), win32
      16 000 ms alıyor. Bu, W3-2'nin `anchorProtocolTimeoutMs`'inin bir katman altındaki
      aynı eşitsizliği.
      Kanıt durumu: yedi test Linux'ta geçiyor (45 sn). Windows kanıtı yok — bu dosyalar
      informational bacağın bütçe kesiğinin ötesinde kalıyor ve hedefli bir
      `win32_test_filter` koşusu gerekiyor.
      Kapanmayan iki şey yazıya geçti: (a) `waitForOwnedGroupChange`'in tabanı yok ve ona
      bir taban koymak POSIX'i yeniden ayarlıyor (`runtime-factory.test.ts`'in 150 ms'lik
      grace ile tek tur dönen replay testi buna dayanıyor), o yüzden dokunulmadı; (b) aynı
      ters sınır kalıbı `runScenario` çağıran ~18 test dosyasında daha var — süpürme kendi
      birimini hak ediyor, çünkü her askıyı 30 sn yerine 120 sn'ye çıkarmak win32
      bacağının 20 dakikalık `--budget`'ını etkiler ve o etki ölçülmeden yapılmamalı.
      **2026-09-21 (W4-3 / 9i):** kümeleme dokümanının kaydettiği tek somut hata —
      `daemon.test.ts`'in `the CLI drives the selected backend rather than a hard-wired
      launchd one` testi, `ServiceLifecycleError: Task Scheduler uid must be a non-negative
      integer` ile inşa aşamasında patlıyor — gerçek bir ürün kusuruydu, enjeksiyon
      tesisatı değil. `createServiceLifecycle` uid'i koşulsuz
      `options.uid ?? process.getuid?.() ?? -1`'den okuyordu; `process.getuid` win32'de hiç
      yok ve `-1` her zaman reddediliyordu, yani **hiçbir açık `uid` verilmeden hiçbir**
      `wtm daemon` alt komutu Windows'ta bir tek `schtasks.exe` argüman vektörü kurulmadan
      önce inşa bile edilemiyordu. `ServiceBackend`'e `usesUid?: boolean` eklendi
      (launchd'nin `gui/<uid>`'ı ve systemd'nin kullanıcı oturumu gibi gerçekten bir POSIX
      uid'e bağlı olup olmadığını backend'in kendisi söylüyor; varsayılan `true`, yani
      darwin/linux hiç değişmedi); win32'de `false`. `uid`/`fileOwnerUid` yoksa ve backend
      uid'e bağlı değilse `0`'a düşüyor — tahmini bir değer değil, çünkü `fs.Stats.uid`
      zaten her zaman `0` Windows'ta (`resources/gc.ts`'in kendi TOCTOU karşılaştırmaları
      için kaydettiği aynı olgu), yani bu satırdan sonraki her `stat.uid !== ownerUid`
      kontrolü Node'un kendisinin zaten vereceği cevapla karşılaştırıyor.
      İkinci, ilişkili kusur aynı dosyada, tek CLI hatasının hiç dokunmadığı bir yolda:
      `windowsProcessInspector.current()` her PID için koşulsuz `state: 'unknown'`
      döndüren bir yer tutucuydu — `process/windows.ts`'in gerçek bir `readStartTime`'ı
      olmadığı bir dönemde yazılmış (D2 TODO), o TODO 9d'de kapandığında hiç
      güncellenmemiş. Sonuç: kendi sürecini asla `live` olarak gözlemleyemediği için
      `withServiceOperationLock`'ın çağırdığı her `current()` daima `LAUNCHD_OPERATION_BUSY`
      fırlatıyordu — yani uid düzeltmesinden *sonra bile* `install`/`uninstall`/`enable`/
      `disable` işlem kilidini alan her Windows işlemi başarısız kalırdı (`status` kilidi
      almadığı için gözlemlenen tek hatada görünmedi). `linuxProcessInspector`'ın zaten
      kullandığı örüntü izlendi: `createWindowsProcessInspector` artık
      `createWindowsProcessPlatform().readStartTime(pid)` üzerinden okuyor, enjekte
      edilebilir bir `WindowsProcessPlatformOptions` alıyor.
      Kanıt durumu: hem uid hem process-inspector düzeltmesi sahte bir `schtasks`/WMI
      sorgu koşucusuna karşı test edildi, tam kapı Linux'ta temiz. Gerçek bir
      `schtasks.exe`/Task Scheduler'a karşı hiçbir kanıt yok — bu dosyanın kendi doküman
      yorumunun zaten söylediği gibi, argüman vektörlerinin şekli kanıtlanıyor, Task
      Scheduler'ın onları kabul ettiği değil. Hedefli bir `win32_test_filter` koşusu
      gerekiyor.
      Kapanmayan: "PowerShell install/uninstall ve completion, Git Bash testi" — birimin
      plan tablosundaki kod alanı — kümeleme dokümanı bu alt-alanlar için hiçbir gözlemlenen
      hata kaydetmiyor (`platform/src/service/__tests__` win32'de hiç koşmadı); yeni kanıt
      olmadan spekülatif bir düzeltme yazılmadı.
- [x] Aynı `wtm.toml` mümkün olduğunca üç OS'ta da çalışıyor.
      **2026-09-21 (W5-3 / 9m):** burada gerçek bir hata vardı. UTF-8 dosyayı okumak byte order
      mark'ı `U+FEFF` olarak string'in içinde bırakıyor, TOML'un onu atlayan bir kuralı yok, yani
      mark'ı varsayılan olarak yazan editörlerin kaydettiği her `wtm.toml` — yazarına göre aynı
      yapılandırma — ilk anahtarın ilk karakterinde sözdizimi hatasıyla reddediliyordu; üstelik
      hiçbir editörün göstermediği bir karakter için gözle bakınca doğru görünen bir satırı
      işaret eden bir mesajla. `stripByteOrderMark` (`packages/core/src/config/toml-text.ts`)
      yalnızca *baştaki* mark'ı siliyor ve diskteki dosyayı hiç yeniden yazmıyor; kullanıcının
      yazdığı bir TOML dosyasını diskten okuyan dört yere de uygulandı (config yükleyici,
      `wtm init`, `wtm detect`, `wtm changes`). Yeni `packages/core/src/config/__tests__/
      cross-platform-config.test.ts` dört kodlamayı (LF, CRLF ve her ikisinin mark'lı hali) hem
      ayrıştırıcıdan hem gerçek yükleyiciden geçiriyor, değerleri birbirleriyle değil yazılı bir
      beklentiyle karşılaştırıyor (hepsinin aynı şekilde yanlış olması hâli görünür kalsın diye)
      ve `wtm explain`'in gösterdiği provenance satır numaralarının kodlamadan bağımsız olduğunu
      sabitliyor. Dosyanın ortasındaki bir mark hâlâ sözdizimi hatası.
      Bilinçli olarak *düzeltilmeyen* tek fark yazıya geçti ve testle sabitlendi: çok satırlı bir
      temel dizenin (`"""…"""`) *içindeki* satır sonu ayırıcı değil değerin kendisi, dolayısıyla
      dosyayla birlikte yolculuk ediyor (CRLF kopya `\r\n`, LF kopya `\n` veriyor). Normalleştirmek
      tırnak içindeki bir değeri yeniden yazmak olurdu; `docs/03-configuration-spec.md`'nin yeni
      "File encoding" bölümü bunu ve taşınabilir yazımın `\n` kaçışı olduğunu söylüyor.
      Kanıt durumu: kodlama testleri fixture (baytlar burada kurgulanıyor, gerçek bir editörden
      gelmiyor — ama `U+FEFF` ve `\r\n` dizileri OS'a değil kendi spesifikasyonlarına bağlı).
      Yol biçimi tarafı zaten `scripts/__tests__/examples-portability.test.ts` ile POSIX ve win32
      path flavor'ları üzerinden kapsanıyordu; buna ek olarak yeni dosyanın son testi host'un kendi
      `node:path`'iyle iç içe workspace katmanlamasını okuyor, yani onu çalıştıran her CI
      bacağında native kanıt — win32 bacağı onu Windows kanıtı yapan şey. Bu oturumda yalnızca
      Linux'ta koştu; GitHub Actions hesap çapında kesintide olduğu için gerçek bir macOS/Windows
      koşusu yok. Dokunulmayan tek okuma yeri `packages/daemon/src/runtime-factory.ts:355`
      (`globalJobPolicy`) — bu dalgada başka bir birimin alanı, ve mark'lı bir global
      `config.toml` orada hâlâ reddedilir; ayrı bir birim olarak kapatılmalı.
- [x] JSON contract platformlar arasında aynı kalıyor. — `definitionPath` her platformda var;
      `plistPath` macOS'a özel bir ek alan olarak bilerek duruyor (D11), kaldırılması daemon JSON
      sözleşmesini kırmak için bağımsız bir nedeni olan ilk artıma programlandı.
      **2026-09-21 (W5-3 / 9m):** ölçüt artık bir cümle değil bir test.
      `packages/cli/src/commands/__tests__/daemon.test.ts` zarfı darwin, linux ve win32 için
      kuruyor ve yayımlanan *anahtar kümelerini* doğrudan karşılaştırıyor — alan alan karşılaştırma
      asıl önemli hata biçimini, yani tek bir platformda sessizce beliren bir anahtarı, göremez.
      linux ile win32 birebir aynı; darwin aynı küme artı yalnızca `plistPath` (harfi harfine
      yazıldı, yani istisnanın büyümesi bu testi düzenlemeyi ve D13/D11'i yeniden okumayı
      gerektirir). Anahtarlar JSON'dan geri okunuyor, böylece `undefined` bir anahtar okuyucunun
      gördüğü gibi "yok" sayılıyor. `ok: false` yarısı da üç platformda aynı şekli ve tek bir kodu
      koruyor; yalnızca servis yöneticisini adlandıran mesaj değişiyor. `published()`'ın kapısı
      `id === 'darwin'` olduğu için win32 yapı gereği linux tarafına düşüyor; bunu sabitlemenin
      değeri mutasyonla doğrulandı (kapı `id !== 'linux'` yapıldığında iki yeni test kırmızıya
      dönüyor). Dördüncü test `label`/`definitionPath` biçimlerini sabitliyor ve
      `docs/04-cli-reference.md`'de gerçek bir sapma yakaladı: tablo Linux etiketini
      `wtm-daemon-<digest>.service` diye veriyordu — sonek tanım *dosyasına* ait, etikete değil —
      ve Windows tabloda hiç yoktu; ikisi de düzeltildi.
      `plistPath`'e dokunulmadı: C1'in D13'ü ile C2'nin D11'i aynı sonuca ayrı ayrı vardı, bu
      artımın onu kırmak için bağımsız bir nedeni yok. Kutu D13'ün "kaldırılana kadar işaretsiz
      kalır" notuna rağmen işaretlendi, çünkü onu D11 geçersiz kıldı: taşınabilir bir tüketicinin
      ihtiyacı olan özellik `definitionPath`'in her platformda bulunması ve bu artık kanıtlı.
      Kanıt durumu: fixture — üç `PlatformRuntime` kimliğe göre kuruluyor, gerçek bir macOS/Windows
      çekirdeğinde ölçüm değil. `schtasks.exe`'in aynı backend'in kurduğu argüman vektörlerini
      kabul ettiği hakkında hiçbir şey söylemiyor; o hâlâ hedefli bir `win32_test_filter` koşusu
      istiyor.
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

### [x] 47. Task komutlarına worktree selector'ü ekle (`--worktree <selector>`)

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

- [x] Selector resolver'ı `remove.ts`'ten ortak bir modüle çıkar; `status`/`analyze`/`remove`
      davranışı bit düzeyinde değişmesin.
- [x] `--worktree <selector>` bayrağını `run`, `start`, `stop`, `restart`, `logs`, `exec`
      komutlarına ekle.
- [x] Repo ayrıştırma kararını uygula ve tek biçim olarak sabitle.
- [x] Bayrak verilmediğinde davranış bugünkü gibi kalsın: bulunulan dizinin worktree'si.
- [x] Workspace kökünden (worktree dışından) çağrıldığında `--worktree` zorunlu olsun ve eksikse
      eyleme dönük hata versin, ham stack trace değil.
- [x] Belirsiz eşleşmede `WorktreeSelectorError` aynı stable JSON error code ile dönsün.
- [x] Shell completion (`wtm __complete worktrees`) bu bayrağı da beslesin.
- [x] `docs/04-cli-reference.md`'de altı komutun tamamında bayrağı belgele.
- [x] `docs/11-ai-first-skill-integration.md` ve `skills/wtm/SKILL.md`'de `cd` gerektirmeyen akışı
      örnekle; ajanın önerilen yolu bu olsun.

#### Kabul kriterleri

- [x] Altı komut da worktree dışından, `cd` olmadan hedef worktree'de çalışıyor.
- [x] Aynı branch birden fazla repoda varken repo ayrıştırması deterministic.
- [x] Belirsiz selector hiçbir komutta yanlış worktree'yi seçmiyor; hata veriyor.
- [x] `--worktree` olmadan çağrılan komutların davranışı değişmemiş.

#### Not (2026-09-14)

Kapandı, branch `claude/item-47-worktree-selector`. Tasarım:
`docs/superpowers/specs/2026-09-14-worktree-selector-design.md`. Repo ayrıştırması `--repo <name>`
olarak sabitlendi (`<repo>:<selector>` değil); `--worktree` olmadan reddediliyor. Yedi komut
`--worktree`/`--repo` alıyor: altı task komutu artı `resolve` (madde metni "altı" diyordu, `resolve`
de aynı seçiciyi kullanıyor). `ps` bayrakları almıyor; işleneceği belirlenmiş bir tek worktree yok.

Planlama sırasında tasarım belgesine düşülen düzeltmeler, madde metninin ve önceki varsayımların
yerini alıyor:

- **`remove` sayıyı zaten kabul ediyordu.** Madde metni ve ilk onaylanan tasarım "`remove` sayı kabul
  etmeye başlıyor" diyordu; `runProductionRemove`/`numericSelectorPath` okununca bunun zaten mevcut
  olduğu görüldü. Değişen tek şey, bir sayı ile farklı bir worktree'yi adlandıran bir dizin adının artık
  her iki komutta da belirsizlik sayılması.
- **Relatif path'ler belgelenen tabanı koruyor.** "`analyze` relatif path'leri `cwd`'ye göre çözüyor"
  denilmişti; `analyze` da `remove` de bugün zaten bulunulan dizinin worktree'sine göre çözüyor
  (`docs/04`'ün belgelediği taban), workspace kökünden çağrıldığında ise `cwd`'nin kendisine göre.
  Tasarım bu tabanı koruyor, değiştirmiyor.
- **Senaryo gerçek bir daemon değil, kaydedici bir runtime client kullanıyor.** Onaylanan tasarım
  `dist/cli/bin.js` üzerinden gerçek bir daemon'ı adlandırmıştı; bu maddenin değiştirdiği tek şey
  CLI'nin `cwd`'yi nasıl seçtiği, daemon tarafında hiçbir şey değişmiyor, dolayısıyla test gerçek bir
  daemon yerine hangi `cwd`'nin gönderildiğini kaydeden bir client kullanıyor.
- **`ps` bayrakları almıyor.** Yedi komutun listesi `resolve`, `run`, `start`, `stop`, `restart`,
  `logs`, `exec`'ten oluşuyor; `ps` zaten tüm workspace'i listeliyor ve tek bir hedef worktree'ye
  bağlı değil.

`docs/18`'de `--repo` durumları arasındaki ayrım netleştirildi: hiç state veritabanı yokken
`--repo` `WTM_NOT_INITIALIZED`, veritabanı var ama `cwd` kayıtlı hiçbir workspace'in içinde değilken
`WTM_WORKSPACE_NOT_FOUND` (`context.cwd`). Tasarım belgesi (`worktree-selector-design.md` §3) ikisini
"`WTM_WORKSPACE_NOT_FOUND` (mevcut not-initialized hatası)" diye tek cümlede birleştiriyor; kod bu
ikisini ayırıyor ve belgeleme kodu esas aldı.

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

### [x] 49. Task kayıtları DB'de tutulsun ve düzenlenebilir olsun (ajan tarafından)

**2026-09-21 tamamlandı (W6-2).** K3 cevabı: DB kaydı `wtm.toml`'u override eder (precedence
zincirinin 8. basamağı, zaten dokümanda "CLI/runtime override" olarak yer tutuluyordu), `wtm
explain` kaynağı `db` olarak gösterir, kapsam yalnızca worktree (workspace/repo scope'u
modellenmedi — K3'ün kendisi bunu tek scope olarak netleştirdi), `wtm task export` var, ayrı bir
trust defteri yok (yazma zaten access-controlled local socket üzerinden, `adapter_trust`'a
benzer ikinci bir onay mekanizması gereksiz görüldü). Migration 016 (`task_overrides`, tek JSON
sütunu `task_json` — sütun sütun patlatmak yerine `taskSchema`'nın tam şekli, `wtm.toml`'daki
`[tasks.<name>]` bloğuyla birebir aynı). `applyTaskOverrides` (core/config/merge.ts) dosya+adapter
katmanının üstüne bindirilip provenance'ı `db` olarak işaretliyor; override bütün task'ı değiştirir
(alan alan merge değil). PR: bkz. proje hafızası. Uygulanmayan/basitleştirilen tek nokta: scope
tek (worktree) olduğu için workspace/repo scope kararı gereksiz kaldı.

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

- [x] Öncelik sırası: DB kaydı override eder (K3). `docs/03-configuration-spec.md`'nin precedence
      zincirine 8. basamak olarak açıkça yazıldı.
- [x] Kaynak provenance: `wtm explain` `db` kaynağını satır numarası olmadan (DB kaydının satırı
      yok) ama açıkça gösteriyor.
- [x] Kalıcılık ve taşınabilirlik: `wtm task export` ile `wtm.toml`'a düşürme yolu var.
- [x] Güvenlik: ayrı bir trust defteri yok (K3) — yazma zaten access-controlled local socket
      üzerinden (`wtm task set`), adapter_trust'a benzer ikinci bir onay mekanizması gereksiz.

#### Yapılacaklar

- [x] State DB'de task override tablosu — K3 scope'u worktree'yle sınırladığı için tek scope
      sütunu (`worktree_id`), workspace/repo scope modellenmedi.
- [x] `wtm task list|show|set|unset` komutları, hepsinde stable `--json`.
- [x] Precedence kararını uygula ve `wtm explain`'de kaynağı göster.
- [x] Placeholder'lar (`{worktree.root}`, `{workspace.root}`, port lease'leri) DB kayıtlarında da
      aynı biçimde çözülüyor — `resolveTask` DB override'ını da aynı `TemplateContext`'le çözüyor,
      ikinci bir interpolation dili yok.
- [x] Trust modeli: ayrı bir kayıt yok (K3) — komutun kendisi (access-controlled socket) trust
      kararı.
- [x] `wtm remove` bir worktree'yi kaldırdığında ona bağlı task kayıtları da temizleniyor.
- [x] `wtm task export` ile `wtm.toml`'a düşürme uygulandı.
- [x] `docs/03-configuration-spec.md`'ye yeni precedence katmanı.
- [x] `docs/04-cli-reference.md`'ye `wtm task` komut ailesi.
- [x] `docs/06-adapter-protocol.md`'ye adapter türevlerinin DB kaydıyla ilişkisi.
- [x] `docs/11-ai-first-skill-integration.md` ve `skills/wtm/SKILL.md`'ye ajanın task düzeltme
      akışı ve yapmaması gerekenler.

#### Kabul kriterleri

- [x] Bir ajan türetilmiş bir task'ı düzeltip kalıcılaştırabiliyor; `wtm.toml` elle düzenlenmiyor.
- [x] `wtm explain` her task için kaynağını (TOML satırı / adapter / DB kaydı) söylüyor.
- [x] Precedence dokümanda yazdığı gibi çalışıyor ve testle sabitleniyor
      (`applyTaskOverrides`/`decisions.test.ts`/`task-override-resolution` senaryosu) — 34/35.
      maddelerin platform-parity testi bu konunun kapsamı dışında, yeni davranış kendi testleriyle
      doğrulandı.
- [x] Worktree kaldırıldığında ardında yetim task kaydı kalmıyor.

---

### [x] 53. Skill ajanın tek WTM başvurusu olsun; CI beklemesin

WTM kullanan ajanlar her konuşmada WTM'in ne olduğunu ve nasıl kullanıldığını README'den, `docs/`'tan
ya da `--help`'ten yeniden araştırıyor ve bunun için token harcıyor. Push ya da PR sonrası da CI'ı
bekleyerek geliştirmeyi durduruyorlar.

2026-09-14 başlangıç ölçümü (mevcut skill ile, sonnet, senaryo başına 3 tekrar): ajanlar README'ye
gitmedi ama task adını bulmak için `wtm.toml`/`Makefile`/`package.json` okudu (3/3), `doctor` ve
`status`'u başta ve sonda tekrarladı, worktree'yi `wtm create` yerine `git worktree add` ile açtı
(6 koşunun 5'inde; skill `create`'i hiç anmıyordu). CI senaryolarında bekleme yeniden üretilemedi;
kural yine de tarif olarak eklendi.

- [x] Skill'in başına "WTM nedir", JSON envelope ve exit sınıfları.
- [x] Görünür her komut için bir satırlık komut haritası.
- [x] Yalnızca skill'de olmayan bir komut ya da bayrak hata olarak dönerse README/`docs`/`--help`.
- [x] Task adları için `wtm resolve` → `context.knownTasks`; worktree için `wtm create`.
- [x] "CI ve uzun beklemeler" bölümü: bir sonraki bağımsız işe geç, iş sınırında bir kez bak, host
      bildirimine güven, yalnızca CI kaldıysa raporla ve turu bitir.
- [x] `skill-reference.test.ts`: komut haritası CLI'daki görünür komutlarla eşleşiyor; skill ≤ 24 KiB.
- [x] `docs/11-ai-first-skill-integration.md` güncellendi.

---

### [x] 54. CI takibi: WTM push/PR sonrası CI'ı izlesin ve AI konuşmasına bildirsin

Ajanlar CI sonucunu beklemek için geliştirmeyi durduruyordu. WTM artık bir push ya da PR'ın CI
koşularını kendisi izliyor; sonuç (başarılı, başarısız job'lar ve log özeti) `wtm ci status`'un
yerel okumasında hazır duruyor ve ajan beklemeden çalışmaya devam ediyor.

#### Yapılacaklar

- [x] Tasarım: CI kaynağı `gh` CLI (yalnızca GitHub), izleme sahibi daemon, bildirimin konuşmaya
      ulaşma yolu bir `wtm` komutu (`wtm ci status`) — bkz. not.
- [ ] ~~Hook kurulumu `wtm skill install` gibi güvenli ve açık rızalı olsun.~~ Ajan-host hook'u
      tasarımdan çıkarıldı: bkz. not.
- [x] `wtm ci watch`, `wtm ci status`, `wtm ci unwatch` komutları ve daemon'ın CI izleyicisi eklendi.
- [x] Skill'deki "CI ve uzun beklemeler" bölümü yeni akışla güncellendi: push sonrası `wtm ci
      watch`, iş sınırında `wtm ci status`, asla bekleme.

**Not (2026-09-14):** Teslimat bir ajan-host hook'u değil, `wtm ci status` komutu: hook'lar
kendiliğinden bir konuşmaya bildirim gönderemez, başka bir aracın ayarlarına yazmak kendi rıza ve
sahiplik tasarımını gerektirir, ve skill zaten ajanlara iş sınırlarında bakmayı öğretiyor (madde
53). Planlama sırasındaki düzeltmeler tasarım belgesinin "Corrections while planning" bölümünde
listeli: `docs/superpowers/specs/2026-09-14-ci-watch-design.md`.

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

**2026-09-21 (W9-4 / 12b):** Maddenin ilk üç alt maddesi tamamlandı: `[proxy]` opsiyonel bir
global-config tablosuyla açılan (varsayılan kapalı) bir yerel reverse proxy, `packages/daemon/src/proxy.ts`
(düz `node:http`, dış bağımlılık yok). Yönlendirme tablosu yeni bir SQLite tablosu/migration
olmadan, mevcut endpoint-lease ve worktree kayıtlarından her istek için taze kuruluyor
(`packages/daemon/src/proxy-routes.ts`) — K8/W9 planındaki "daemon memory, not a new table"
kararının ruhuna uygun, ama isim olarak `idle-runtime.ts`'deki gibi kalıcı bir cache değil: istek
başına yeniden hesaplama, hem her zaman güncel kalıyor hem de invalidation mantığı gerektirmiyor;
bu bilinçli bir sapma, raporda ayrıca belirtildi. Hostname şeması ve slug/çakışma kuralı core'a
taşındı (`packages/core/src/runtime/proxy-hostname.ts`, `assignProxySlugs`/`proxyHostname`), böylece
ileride `wtm status`/`wtm ports` veya CORS entegrasyonu aynı mantığı tekrar yazmadan kullanabilir
(K8'in "nice to have" notu, madde 8). Detaylar: `docs/07-process-port-runtime.md`'in "Local reverse
proxy" bölümü (hostname formatı, çakışma kuralı, port 80 kısıtı) ve `docs/03-configuration-spec.md`'in
aynı adlı bölümü (`[proxy]` şeması, global-config-only olma nedeni).

Kasıtlı olarak kapsam dışı bırakılanlar — ayrı, sonraki birimler:

- HTTPS / local certificate stratejisi — K8'de belirsiz süreyle ertelendi (bkz.
  `docs/superpowers/plans/2026-09-15-remaining-work-waves.md` K8 satırı); bu birim hiç dokunmadı.
- CORS origins ile otomatik entegrasyon — W10-1'in işi (`packages/core/src/runtime/cors.ts`
  bilinçli olarak değiştirilmedi; bu birime sadece çakışmamak için okundu).
- Port allocation ile backward compatibility — bu proxy port tahsisini hiç değiştirmiyor, sadece
  mevcut lease'lerin üzerine bir hostname katmanı ekliyor; ayrı bir uyumluluk sorunu doğurmuyor,
  ama madde kendi checklist'inde kapalı kalsın diye işaretlenmedi.

Madde 12'nin kendi başlığı bu yüzden `[ ]` kalıyor — tam kapsam (port numaralarını tamamen gizlemek)
teslim edilmedi ve edilmeyecek: port 80'e bind etmek root/setcap (Linux) veya admin hakları
(Windows) gerektiriyor, bu birim onu denemiyor. Kullanıcının gördüğü URL hâlâ `:<proxy-port>`
taşıyor — dinamik bir portu ezberlemek yerine kararlı bir hostname'i ezberlemek, gerçek ama kısmi
bir kazanım.

#### Yapılacaklar

- [x] Local reverse proxy backend. **(2026-09-21, W9-4)**
- [x] Feature/repo/endpoint domain naming. **(2026-09-21, W9-4)**
- [x] Stable hostname allocation. **(2026-09-21, W9-4)**
- [ ] HTTPS gerekiyorsa local certificate strategy.
- [x] CORS origins ile otomatik entegrasyon. **(2026-09-21, W10-1)**
- [ ] Port allocation ile backward compatibility.

**2026-09-21 (W10-1, CORS yarısı):** `[proxy] enabled = true` iken, `resolveWorktreeRuntime`
(`packages/daemon/src/task-resolution.ts`) artık `endpoints.leases`'i `endpoints.origins` ile
port üzerinden eşleştirip (`origin != false` opt-out'una sahip olan lease'ler için) her birine
`canonicalProxyHostname` ile bir proxy-hostname origin'i hesaplıyor ve bunu `resolveCors`'a giden
`origins` dizisine dinamik-port origin'inin yanına, onun yerine değil, ekliyor —
`packages/core/src/runtime/cors.ts`'in kendisi hâlâ dokunulmadı (imzası ve davranışı aynı; tek
değişen, çağıranın ona verdiği düz origin listesi). Sabit port'lu (fixed strategy) endpoint'ler
lease taşımadığı ve proxy'nin kendi routing tablosu (`proxy-routes.ts`) da sadece aktif
lease'lerden kurulduğu için zaten proxy üzerinden hiç erişilemiyor — bu yüzden onlara proxy-origin
eklenmedi, bu bilinçli bir "aynı küme" kararı. `runtime-factory.ts`'deki private
`globalProxyPolicy` fonksiyonu `packages/daemon/src/proxy-policy.ts`'ye taşındı; iki çağıran
(`runtime-factory.ts`, `task-resolution.ts`) artık aynı parse-and-catch-ENOENT mantığını
paylaşıyor, davranış değişmedi. `[proxy]` kapalıyken (varsayılan) davranış birebir eskisiyle
aynı — ek origin yok, ek config okuması yok (ENOENT yolu zaten vardı); bu ayrı bir testle
kanıtlandı (`packages/daemon/src/__tests__/proxy-cors-integration.test.ts`).

Madde 12'nin kendi başlığı ve "HTTPS gerekiyorsa local certificate strategy" alt maddesi bilinçli
olarak `[ ]` kalıyor: bu birim sadece CORS yarısını kapsıyor (bkz. görev tanımındaki "W10-1, CORS
half only"), HTTPS/local certificate stratejisi ayrı bir birim ve gerçek bir sistem-trust-store
etkisi taşıyor — yerel bir CA üretip işletim sistemine/tarayıcıya güvendirmek anlamına geliyor,
bu da proje sahibinden ayrı, açık bir onay gerektiriyor (ör. "sertifika materyalini WTM'in kendi
state dizinine üret ama ayrı, açık bir komut olmadan asla sistem trust store'una otomatik
kurma"); bu birim o kararı hiç almadı ve HTTPS'e hiç dokunmadı — proxy origin'leri hâlâ `http://`,
proxy'nin bugünkü HTTP-only gerçeğiyle uyumlu (`docs/07`'nin bu konudaki dürüst notuna bakın).

---

### [x] 13. GitHub / PR awareness

**2026-09-21 tamamlandı (W6-3).** K4 cevabı: `wtm status`'un içinde opsiyonel bir bölüm, network
kullanımı explicit `--pr` bayrağıyla sınırlı. `CiProvider.findPr(repository, branch)` yeni bir
provider metodu (`packages/core/src/ci/provider.ts`), `github-provider.ts`'de `gh pr view` ile
uygulandı; PR'ı olmayan branch için `gh`'nin "no pull requests found" çıktısı hata değil `null`
sonuç olarak ele alınıyor. `checks` alanı ayrı bir vocabulary icat etmek yerine mevcut
`aggregateCiRuns`/`CiVerdict`'i (`packages/core/src/ci/aggregate.ts`) kullanıyor — zaten PR'ın
head commit'i için `listRuns` çağrısı gerekiyordu, `wtm ci watch`'ın `ciWatchStateSchema`'sını
tekrarlamak yerine bunu paylaştı. `wtm status` hâlihazırda daemon'a hiç gitmeden CLI sürecinden
SQLite'ı doğrudan okuyor (`state-diagnostics.ts`); `--pr` de aynı şekilde CLI-local kaldı — `gh`
çağrısı için daemon'un `CiWatcher`'ının kullandığı aynı `createGitHubProvider`/`createGhRunner`
(`@wtm/daemon/ci` altında yeni bir subpath export) doğrudan çağrılıyor, yeni bir IPC komutu veya
migration yok (K4'ün kendisi de "no migration needed" diyordu). gh kullanılamıyorsa (`missing`,
`unauthenticated`, desteklenmeyen remote) komut hata vermiyor: `pr.summary: null` +
`pr.detail: <sebep>`, `resources[].detail`'in zaten kullandığı örüntünün aynısı — ayrı bir
envelope-level warning kanalı icat etmek yerine (ön-K4 tasarım notunun önerdiği gibi) mevcut
örüntüyü tekrar kullanmak daha basitti. Uygulanmayan tek nokta: PR'ın kendi checks alanı ayrı bir
lookup başarısızlığında `checks` alanı tamamen omit ediliyor (bir yanlış değer uydurmak yerine).

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

- [x] Core için GitHub zorunlu dependency olmasın. (`CiProvider` arayüzü core'da, `gh` çağrısı
      yalnızca daemon'daki `github-provider.ts`'de; aynı sınır `wtm ci watch` için zaten vardı.)
- [x] Network kullanımı explicit olsun. (`--pr` bayrağı olmadan `wtm status` hiç network'e çıkmaz.)
- [x] GitHub CLI (`gh`) veya adapter üzerinden uygulanabilir. (`gh pr view`.)
- [x] GitLab/Bitbucket desteğini engellemeyecek interface kullan. (`findPr` `CiProvider`'ın bir
      metodu; başka bir provider aynı arayüzü kendi CLI'ı için uygulayabilir.)

---

### [x] 14. Automatic idle runtime suspension

Uzun süre kullanılmayan managed task'lar isteğe bağlı durdurulabilsin.

Config (task başına; maddenin ilk taslağındaki kök `[runtime.idle]` tablosu **kullanılmadı**):

```toml
[tasks.dev.idle]
enabled = true
timeout = "30m"
```

**2026-09-21 (W8-3 / 14):** kök tablo yerine task başına opt-in seçildi. İki nedeni var:
`docs/07` kök config şemasının strict olduğunu ve `runtime` tablosu bulunmadığını yazılı bir
değişmez olarak ilan ediyor; ve workspace geneli bir anahtar, "hangi task interaktif sayılır"
sorusunu bir sezgiselle çözmek zorunda kalırdı. Task başına opt-in ikisini de ortadan kaldırıyor.
`timeout`, mevcut task süre dilbilgisini (`ms|s|m|h`) yeniden kullanıyor; alt sınır 1s, çünkü
kararı veren süpürme periyodik ve bundan ince bir pencere tutulamaz. `queue = true` olan bir
task'ta `idle` reddediliyor (şemada ve politika okuyucusunda iki kez): kuyruk işi zaten kendi
sonlu timeout'uyla bitiyor ve `wtm start` ile yönetilen uzun ömürlü bir süreç değil.

**Migration 018 kullanılmadı ve gerekmiyor.** Aktivite saatleri yalnızca daemon belleğinde
(`packages/daemon/src/idle-runtime.ts`) tutuluyor; yeni tablo, yeni kolon ve yeni
`ManagedProcessState` yok. Askıya alma mevcut stop yolundan geçiyor ve süreç mevcut `STOPPED`
durumunda bitiyor, bu yüzden resume için de yeni kod yok: `wtm start <task>` zaten çalışmayan bir
singleton task'ı başlatıyor. Daemon yeniden başlarsa saatler sıfırlanır — dokümante edilmiş,
"çalışır bırakma" yönünde hata yapan bir ödünleşim. 018 numarası bu yüzden boş kalıyor; bir
sonraki migration onu kullanabilir.

#### Güvenlik

- [x] Default kapalı. **(2026-09-21, W8-3)** `enabled` yazılmadıkça `false`; `idle` bloğu olmayan
      hiçbir task süpürmeye girmiyor, kök tablo veya workspace geneli anahtar yok.
- [x] Interactive/debug task'larda yanlışlıkla stop etmemeli. **(2026-09-21, W8-3)** Opt-in task
      başına olduğu için interaktif/debug task'lar hiçbir şey yazmayarak kapsam dışında kalıyor.
      `wtm run`/`wtm exec` foreground süreçleri yapısal olarak erişilemez (supervisor kaydı yok),
      heavy-job kuyruğu ise `queue = true` reddi sayesinde.
- [x] Resume strategy net olmalı. **(2026-09-21, W8-3, K6 kararı)** Resume yalnızca bir sonraki
      `wtm start`/`wtm restart` çağrısıyla; proxy veya ağ trafiği gözlemiyle asla (WTM'nin reverse
      proxy'si yok, o ayrı bir birim). Neden durdurulduğu task'ın kendi log akışına tek satır
      olarak yazılıyor, `wtm logs <task>` okuyor; yeni komut/alan eklenmedi.
- [x] Agent activity ile human activity ayrımı zorunlu değil ama ileride desteklenebilir.
      **(2026-09-21, W8-3)** Ayrım yapılmadı: her daemon isteği (start/restart, readiness bekleme,
      `wtm ps`, `wtm logs`) tek tip "WTM etkileşimi" sayılıyor. Etkileşimin kaynağı
      `DaemonRuntimeController.onTaskActivity` tek kapısından geçtiği için ileride ayrım eklenmek
      istenirse tek yerde genişletilir.

**Bilinçli sınır (dokümante edildi, `docs/03` + `docs/07` + skill):** WTM boşta kalmayı yalnızca
kendi CLI/daemon etkileşimlerinden ölçüyor, task'ın portuna gelen gerçek trafikten değil. Reverse
proxy olmadığı için, pencere boyunca hiç WTM komutu çalıştırılmadan yalnızca tarayıcı/API trafiği
alan bir task da askıya alınır. Doküman ve mesajlar bundan fazlasını iddia etmiyor.

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

### [x] 18. Port probing'i batch hale getir

**2026-09-10:** Node ve standalone tahsis yolu artık en fazla 256 adayı tek helper'a gönderir.
SQLite transaction içindeki lease çakışma filtresi, mevcut port ve preferred port sırası korunur.
İki saniye toplam süre, 128 KiB stdin ve 4 KiB yanıt sınırı vardır; bozuk/eksik yanıt veya
timeout port tahsis etmez. Eski tekli probe enjeksiyonları desteklenir. Bağımsız review tamamlandı;
bulunan UDP descriptor sızıntısı gerçek private CLI testiyle giderildi. Son native CI takibi açık.

- [x] Tek process üzerinden sınırlı toplu bind/close kontrolü.
- [x] Node ve standalone private girişleri, TCP/UDP ve transaction çakışma testleri.
- [x] Bağımsız review; UDP descriptor bulgusu giderildi ve yeniden incelendi.
- [x] Son düzeltmenin native CI sonuçları; `75a8626` Linux/ARM64 başarılı, Intel iki hata.
      **2026-09-16:** `f266b1f` / `34947174999` darwin x64 bacağı tam yeşil (port probe testleri
      dahil); `360a7da` / `34947190062` Linux x64, Linux arm64 ve darwin arm64 yeşil.

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

### [x] 20. Workspace presets / templates

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

#### Yapılacaklar

- [x] `wtm init` komutuna `--preset <name>` bayrağı ekle; sabit, bilinen yedi isimle sınırlı.
- [x] Bilinmeyen preset ismi, bilinen listeyi sayan `WTM_CONFIG_INVALID` zarfıyla reddedilsin.
- [x] Eksik beş örneği (`nextjs`, `nextjs-hono`, `python-uv`, `rust`, `go`) `examples/` altına,
      mevcut `bun-monorepo`/`docker-compose` ile aynı üslupta ekle; `examples/README.md`'ye
      birer paragraf düş.
- [x] `--preset`, `examples/<name>/wtm.toml` dosyasını olduğu gibi okusun (TOML içeriği
      TypeScript'te tekrarlanmasın), yalnızca `[workspace]` adını gerçek workspace adıyla
      değiştirsin.
- [x] `--preset` ve detection etkileşimini netleştir ve uygula: detection (kapatılmadıysa) hiçbir
      şey yazmayacaksa preset tüm dosyayı tohumlar; detection gerçekten bir şey bulduysa `--preset`
      sessizce ezmek yerine `preset-detection-conflict` bağlamıyla reddedilir ve `--no-detect
      --preset <name>` önerilir; `wtm.toml` zaten varsa `wtm init` onu hiç düzenlemediği için
      preset uygulanmaz, `data.preset = { applied: false }` ve bir uyarı döner.
- [x] `docs/09-init-scope-discovery.md`'ye "Workspace presets (`--preset`)" bölümünü, `docs/04-cli-reference.md`'ye bayrağı belgele.
- [x] `packages/core/src/workspace/__tests__/init.integration.test.ts` ve
      `packages/cli/src/commands/__tests__/init.test.ts`'e testler ekle: bilinmeyen isim
      reddediliyor, bilinen preset görev adlarını tohumluyor, mevcut dosyada uygulanmıyor, gerçek
      detection sonucuyla çakışınca reddediliyor.

#### Kabul kriterleri

- [x] `wtm init --preset <name>` boş bir dizinde beklenen görev adlarını (`dev`/`test`) içeren bir
      `wtm.toml` üretiyor.
- [x] Detection gerçek bir servis bulduğunda `--preset` sessizce hiçbir şeyi (ne kendini ne
      detection'ı) ezmiyor; açık bir hatayla reddediyor.
- [x] `wtm.toml` zaten varken `--preset` dosyayı değiştirmiyor.
- [x] `bun run typecheck && bun run lint` temiz; ilgili test dosyaları (`bun test
      packages/core/src/workspace/__tests__/init.integration.test.ts
      packages/cli/src/commands/__tests__/init.test.ts`) geçiyor.

#### Not (2026-09-21)

Kapandı, branch `claude/w9-2-workspace-presets`. Preset içeriği `@wtm/core`'a gömülmedi:
`packages/cli/src/assets.ts`'teki `filesystemPresetAssets`, `skills/wtm/SKILL.md` için zaten var
olan `canonicalSkillPathForModule` desenini birebir izleyerek `examples/<name>/wtm.toml`'u
dev/npm-paketli düzende okuyor; `@wtm/core`'un `initializeWorkspace`'i yalnızca zaten okunmuş
`{ name, toml }` çiftini görüyor, presetlerin dosya olduğunu hiç bilmiyor. `dist/cli/examples/`
kopyası için kök `package.json`'daki `build` betiğine bir `cp -r` satırı eklendi (SKILL.md'nin
`dist/cli/skills/`'e kopyalanmasıyla aynı desen).

**Bilinçli kapsam dışı bırakma:** standalone SEA yürütülebilir dosyası (`wtm.blob`) presetleri
`seaSkillAssets`/`seaMigrationAssets`'in yaptığı gibi gömmüyor; o üç dosyayı
(`scripts/build-sea.ts`, `packages/cli/src/sea-assets.ts`, `packages/cli/src/sea-bin.ts`) birlikte
değiştirmek gerekirdi ve bu, aynı anda süren başka birimlerin de dokunabileceği paylaşılan
paketleme altyapısı. SEA derlemesinde `wtm init --preset` bugün "preset bu kurulumda eksik" hatası
veriyor; npm paketinde ve monorepo geliştirme ortamında tam çalışıyor. Bu, gelecekte ayrı bir
birimin üstlenebileceği açık bir takip maddesi.

Hata kodu için yeni bir `WtmErrorCode` eklenmedi: hem bilinmeyen preset ismi hem
preset/detection çakışması, zaten `wtm init`'in geçersiz girdiler için kullandığı
`WTM_CONFIG_INVALID`'i (mevcut `WtmConfigError` sınıfı üzerinden) yeniden kullanıyor —
`context.conflict`/`context.preset`/`context.knownPresets` alanlarıyla ayırt edilebilir durumda,
`docs/18-errors-json-contract.md`'de zaten belgelenen kodun context alanları genişletilmiş
oluyor, yeni bir kod protokole eklenmiyor.

---

### [ ] 21. Plugin / adapter ecosystem geliştirme

- [x] Adapter SDK package. — **Not (2026-09-21, W10-2):** `packages/adapter-sdk`
      (`@wtm/adapter-sdk`), `@wtm/protocol`'a bağımlı, katmanlamada `adapters` ile aynı seviyede
      (yalnızca protocol'e bağlı, OS'a özel hiçbir şey yok). İki dışa aktarım: `.` —
      `defineAdapter` (yazar handler nesnesini `AdapterHandlers`'a karşı tip kontrolünden geçiren
      identity fonksiyonu) ve `runAdapter` (docs/06'daki tam stdin/stdout döngüsü: stdin'i
      tüketir, `adapterRequestSchema`'ya karşı doğrular, protokol sürümünü kontrol eder, ilgili
      handler'ı çağırır, `metadata`'yı `{protocol, adapter}` zarfına, `doctor`'ı `{findings}`'e
      sarar, stdout'a yazar). `runAdapter` `process.exitCode`'a asla dokunmuyor — bir
      `Promise<boolean>` döndürüyor, çağıran `process.exitCode = (await runAdapter(...)) ? 0 : 1`
      yazıyor; bunun nedeni test edilebilirlik (global süreç durumuna gizli yan etki yerine açık
      dönüş değeri) ve bunu testler sırasında `process.exitCode`'un test dosyaları arasında
      sızdığını (bun'ın genel exit kodunu "kirletmesi") gözlemleyerek keşfettim. `./testing`
      alt-yolu — `invokeAdapter`: gerçek bir dosyayı `node <dosya>` ile çalıştırıp bir istek
      gönderen, yanıtı aynı protokol şemalarına karşı doğrulayan geliştirme-zamanı test aracı;
      WTM'nin gerçek doğrulayıp-tanımlayıcıyla-çalıştır güven mekanizmasının (`external-adapter.ts`)
      yerini tutmadığı açıkça belirtiliyor. **Karar:** paket şimdilik dahili (`private: true`,
      diğer tüm workspace paketleri gibi) kalıyor — npm'e yayımlamak ayrı, riskli, paylaşılan
      release altyapısını etkileyen bir karar (kökteki `wtm` paketinin ilk npm 2FA + `@next`
      yayımı zaten madde 38a'da Kaptan'ın eli bekleyen bir kapı; ikinci bir paketi yayımlamak aynı
      sınıftan, ayrı bir takip konusu). Yazım rehberi bunu açıkça belirtip yayımlanana kadar
      `packages/adapter-sdk/src`'in vendor edilmesini öneriyor. `bun run typecheck`'e
      `packages/adapter-sdk/tsconfig.json` eklendi; `build` betiğine eklenmedi çünkü yayımlanan
      `wtm` CLI'sinin hiçbir yeri bu paketi içe aktarmıyor (test kit gibi, yalnızca geliştirme
      zamanı paketi).
- [x] Adapter authoring guide. — **Not (2026-09-21, W10-2):** `docs/19-adapter-authoring-guide.md`
      (ilk boş numara), `docs/README.md`'nin belge indeksine eklendi. SDK'nın ne olduğunu/olmadığını
      (derleme-zamanı bağımlılığı, tek dosya paketleme zorunluluğu), `defineAdapter`/`runAdapter`
      kullanımını, `wtm-adapter-v1: self-contained` başlığıyla paketleme adımını, `invokeAdapter` ile
      yerel test etmeyi ve `wtm adapter trust`'a geçişi anlatıyor. `doctor` bulgularının `code`
      alanının serbest metin olmadığını, `@wtm/protocol`'ün paylaşılan `WtmErrorCode` enum'undan
      geldiğini de not ediyor (kod yazarken teste yansıyan gerçek bir kısıt, SDK'nın kendi
      sınırlaması değil). `docs/06-adapter-protocol.md`'ye SDK'ya işaret eden bir paragraf eklendi.
- [x] Adapter contract versioning. — **Not (2026-09-21, W9-3 / K9):** zaten uygulanmış:
      `packages/protocol/src/adapter.ts`'te `protocolVersionSchema` (`{ major, minor }`) ve
      `isProtocolVersionCompatible`; gerçek yürütme yollarında zorunlu kılınıyor
      (`packages/cli/src/client.ts:300`, `packages/core/src/plan/external-adapter.ts:389` —
      uyumsuz protokolü `incompatible protocol` ile reddediyor), `docs/06-adapter-protocol.md`'nin
      "Protocol version" bölümünde major/minor kuralları belgeli (major uyuşmazlığı
      uyumsuz; adapter'ın eski minor'ü, gerekli alanlar destekleniyorsa kabul; adapter'ın yeni
      minor'ü, yalnızca ileri-uyumlu işaretlenmiş opsiyonel alanlar yoksayılarak). Bugün v1.0 tek
      minor olduğu için `isProtocolVersionCompatible` basit eşitlik kontrolü yapıyor — bu, kuralın
      basitleştirilmesi değil, kuralın v1.0'da eşitliğe indirgenmiş hâli (yorum satırı bunu
      açıkça söylüyor); ikinci bir minor tanımlandığında eşitlik kontrolü genişletilmeli. Yeni kod
      yazılmadı, yalnızca bu madde işaretlendi.
- [x] Adapter test harness. — **Not (2026-09-21, W10-2):** `@wtm/adapter-sdk/testing`'in
      `invokeAdapter`'ı olarak teslim edildi (yukarıdaki "Adapter SDK package" notuna bakın) —
      ayrı bir paket/araç olarak değil, SDK'nın bir alt-yolu olarak, çünkü ikisi aynı protokol
      şemalarını paylaşıyor ve ayrı bir paket gereksiz dolaylama olurdu. `packages/testkit/src/
      fake-adapter.ts`'in aksine (WTM'nin kendi spawn/trust/timeout makinesini bozan senaryolar
      için bir çift), bu gerçek bir aday adapter dosyasını çalıştırıp yanıtını doğrulamak için var.
- [x] Trust UX iyileştirmesi. — **Not (2026-09-21, W10-3):** kapsam plan belgesinde
      detaylandırılmamıştı, bu yüzden gerçek boşluk mevcut kod okunarak belirlendi: `assertTrusted`
      zaten adapterId+SHA-256 eşleşmesiyle çalışıyor, yani değişen/bozulmuş bir binary zaten
      otomatik reddediliyor — güvenlik boşluğu yok. Asıl eksik, kasıtlı bir güveni geri almanın
      hiçbir CLI yolunun olmamasıydı. **Karar:** `wtm adapter untrust <adapter-id>` eklendi
      (`AdapterTrustStateStore.deleteAdapterTrust`, `AdapterTrustStore.untrust`,
      `packages/cli/src/commands/adapter.ts`, `main.ts`), CLI genelindeki mevcut
      "boolean sonuç" deseni izlenerek (`wtm ci unwatch` → `{stopped}`, `wtm task unset` →
      `{removed}`) `{removed: boolean}` döndürüyor, hiçbir şey yoksa asla hata vermiyor — neden:
      tutarlılık, ayrı bir envelope hata koduna gerek yok. Migration yok (yeni sütun/tablo yok,
      var olan `adapter_trust` tablosundan silme). `docs/04-cli-reference.md`'ye ilk kez bir
      "Adapters" bölümü eklendi (daha önce `wtm adapter` hiç belgelenmemişti),
      `docs/06-adapter-protocol.md`'nin Trust model bölümü ve `skills/wtm/SKILL.md` güncellendi.
      Yanlışsa bedeli: düşük — yalnızca yerel SQLite tablosundan satır silen, ağa çıkmayan, geriye
      dönük uyumluluğu bozmayan katkısal bir CLI komutu; K3'ün "ayrı bir trust ledger yok, `wtm
      task set` erişim kontrollü local socket üzerinden zaten güven kararı" ilkesiyle çelişmiyor,
      çünkü bu adapter trust'ı (K3'ün task override konusu değil) ve zaten var olan tabloyu
      yönetiyor.
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

- [x] Install scriptlerin checksum doğrulaması yapması. — `install.sh` ve `install.ps1` archive'i
      indirip `SHA256SUMS`'a karşı doğruluyor (`shasum -a 256 -c --ignore-missing` / `sha256sum`
      fallback'i, `Get-FileHash -Algorithm SHA256` karşılaştırması); eşleşmeyen checksum sert hata
      ve hiçbir şey kurmadan çıkıyor.
- [x] Architecture autodetection. — `install.sh` `uname -s`/`uname -m`'i beş yayınlanan hedeften
      (`scripts/artifact-targets.ts`) birine eşliyor, `install.ps1` `$env:PROCESSOR_ARCHITECTURE`
      okuyor; desteklenmeyen platform/mimari indirme yapmadan açık hata veriyor (test seam'i:
      `WTM_INSTALL_OS`/`WTM_INSTALL_ARCH`).
- [x] Existing install upgrade desteği. — her iki script de var olan `wtm`/`wtm.exe`'yi ayrı bir
      tespit adımı olmadan yerinde temiz şekilde değiştiriyor; fixture testinde iki ayrı sürümle
      arka arkaya çalıştırılıp içerik ve mod bitinin güncellendiği doğrulandı.
- [x] Uninstall dokümantasyonu. — README/CONTRIBUTING `make uninstall` ile state silen
      `make purge`'ü ayırır; macOS state/log ve Linux XDG state/config köklerini, npm kaldırmayı
      ve Windows için önce doctor kökleri/süreç durumu doğrulamasını açıklar. Installer script'leri açık.

**Not (2026-09-21, W8-2 / 24):** `install.sh` (POSIX `sh`, macOS + Linux) ve `install.ps1`
(PowerShell 5.1+, Windows) eklendi — README'nin manuel curl+shasum adımlarının script'e çevrilmiş
hali, `curl -fsSL .../install.sh | sh` / `irm .../install.ps1 | iex` tek satırlık deneyimi olarak.
Her iki script de: platform/mimariyi `scripts/artifact-targets.ts`'teki beş yayınlanan hedefe
eşliyor (desteklenmeyen kombinasyon indirme yapmadan net hata veriyor — test seam'i
`WTM_INSTALL_OS`/`WTM_INSTALL_ARCH`), sürümü GitHub'ın `releases/latest` redirect'inden çözüyor ya
da `--version`/`-v`/`WTM_INSTALL_VERSION` ile açıkça alıyor, archive + `SHA256SUMS`'ı indirip
checksum'ı doğrulamadan hiçbir şey çıkarmıyor, ve `$HOME/.local/bin` (`--prefix`/
`WTM_INSTALL_PREFIX` ile değiştirilebilir; Windows'ta `$env:LOCALAPPDATA\wtm\bin`) altına kuruyor.
Daemon kaydı yapmıyor — o `make install`'un işi, bu script'lerin kapsamı yalnızca binary. Her
network/base-URL noktası `WTM_INSTALL_BASE_URL` ile override edilebiliyor, tam olarak
`scripts/__tests__/install-script.test.ts`'in yerel bir `Bun.serve` fixture sunucusuna karşı
çalıştırabilmesi için. O test dosyası `install.sh`'ı gerçek bir alt süreç olarak (`Bun.spawn` —
`spawnSync` fixture sunucusuyla aynı event loop'u kilitleyip deadlock yarattığı için tercih
edilmedi) temiz kurulum, bozuk checksum, upgrade/overwrite ve desteklenmeyen platform senaryolarında
koşuyor; 10 test de yeşil (`bun test scripts/__tests__/install-script.test.ts`).

İki açık kanıt boşluğu kalıyor, ikisi de win32/outage boşluklarıyla aynı kategoride
(`docs/superpowers/plans/`): (1) bu depodan hiçbir tag Linux veya Windows archive'ı yayınlamadı —
sadece macOS-only `v0.1.0-rc.1` prerelease'i var, yani her iki script'in gerçek indirme yolu hâlâ
kanıtsız; (2) `install.ps1` hiç çalıştırılmadı — bu sandbox'ta `pwsh`/`powershell` yok
(`which pwsh powershell` doğrulandı), o yüzden yalnızca yapısal kontroller var (dosya var/boş
değil, süslü parantez/tırnak sayıları eşleşiyor, gerekli parametreler/env değişkenleri mevcut).
Her iki boşluk da gerçek kanıt geldiğinde kapanacak; README ve docs/12 aynı dille işaretlendi.

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

**2026-09-21 Linux yayımlama dilimi (29a):** `publishedReleaseTargets` artık dört hedef —
Darwin arm64/x64 ve Linux x64/arm64 — ve `release.yml` bunları ayrı bir `verify-linux` job'ıyla
(`ubuntu-24.04`, `ubuntu-24.04-arm`) üretip gerçek release asset'i olarak yayımlıyor. Signing ve
notarization platform ailesine göre kapsandı: Linux bacakları `codesign`/`notarytool`/`spctl`
çalıştırmaz ve ikisi için de `not-applicable` bildirir; `verify-release.ts` bu cevabı yalnızca
macOS arşivi içermeyen bir seçim için kabul eder, macOS arşivinin aynı cevabı vermesini ve Linux
bacağının üretemeyeceği bir imzayı iddia etmesini reddeder. **Hiçbir CI çalışması yok:** GitHub
Actions hesap düzeyinde kesintide (2026-09-21), dolayısıyla yeni YAML'ın tek kanıtı yerel birim
testleri ve gerçek `release:gate` betiğinin her job'ın env şekliyle elle koşturulmasıdır; gerçek
bir tag'de Linux arşivinin üretilip yayımlandığı görülmedi.

**2026-09-21 Windows yayımlama dilimi (W6-1 / 29b):** `publishedReleaseTargets` artık beş hedef —
önceki dördüne `win32/x64` (`wtm-windows-x64.zip`, `wtm.exe`) eklendi. `release-artifacts.ts` PE
(MZ + "PE\0\0" + machine alanı) başlığını doğruluyor — `readPrefix`'in üst sınırı 64'ten 1024 bayta
çıkarıldı, çünkü `e_lfanew` bu sınırın ötesine işaret edebiliyor — ve GNU tar yerine
`Compress-Archive` (PowerShell, her `windows-latest` runner'da hazır) ile zip'liyor.
`release.yml`'e ayrı bir `verify-windows` job'ı eklendi (`windows-latest`); signing/notarization
Linux gibi `not-applicable`. Bu job `release:verify` composite script'ini **çağırmıyor**: `bun run
test`'in düz 60 saniyelik sınırı, `ci.yml`'in win32 bacağının ölçüp belgelediği gerçek
`Get-Acl`/PowerShell maliyetini (`ManagedLogStore` rotasyon testleri, 149-180 sn) karşılamıyor;
bunun yerine aynı adımlar tek tek, `test` adımı `--timeout 300000 --budget 1200000` ile (yine
`ci.yml`'in kendi ölçtüğü değerler) çalıştırılıyor. `publish` job'ı: `needs` listesine
`verify-windows` eklendi, "Collect every architecture" artık `.zip`'i de topluyor,
`attest-build-provenance`'ın `subject-path`'i `*.tar.gz` ve `*.zip`'i kapsıyor, `gh release create`
komutuna `wtm-windows-x64.zip` eklendi. `sea-smoke.test.ts`'teki "ships a stripped runtime" testi
Windows için ayrı, daha geniş bir üst sınıra (140MB) ayrıldı — `build-sea.ts` zaten Windows'ta
strip çalıştırmadığını belgeliyor, dolayısıyla POSIX sınırı orada anlamsız; **140MB rakamı
ölçülmedi, `build-sea.ts`'in belgelediği "~25MB fazla" tahminine dayanıyor.**

**Ölçülmeyen:** bu dilim de GitHub Actions kesintisi sırasında yazıldı (bkz.
`docs/development/github-actions-outage-2026-09-21.md` benzeri not) — gerçek bir `windows-latest`
runner'da hiçbir adım (build, smoke, zip, boyut sınırı) çalıştırılmadı. Tek kanıt: yerel Linux
gate'in (`typecheck && lint && test`, sahte/fixture PE header'larıyla) yeşil olması ve
`release-artifacts.ts`/`verify-release.ts`/`release.yml` yapısal testlerinin güncellenmiş beş
hedefi doğrulaması. `win32_test_filter` ile hedefli bir workflow_dispatch çalışması, gerçek
kanıtın tek yolu.

- [~] Artifact names stable contract olsun. — beş yayımlanan hedef (Darwin arm64/x64, Linux
      x64/arm64, Windows x64) ortak katalogda ve release workflow'unu sürüyor; adlar
      `publishedReleaseTargets`'tan türetiliyor ve yapısal test workflow ile katalogun
      ayrışmasını engelliyor.
- [~] Her platform smoke tested. — `sea-smoke.test.ts` zaten `windows`'a göre dallanıyor (exe
      uzantısı, `ping`-tabanlı görev fixture'ı) ve `verify-windows` job'ı aynı suite'i çalıştırıp
      sonucu gate'e veriyor. Gerçek `windows-latest` runner kanıtı yok (Actions kesintisi).
- [~] Checksums tüm platformları kapsasın. — `SHA256SUMS` beş arşivin birleşimi ve gate
      eksik/fazla girdiyi reddediyor (yerel olarak, sahte PE fixture'larıyla doğrulandı).
- [~] Build provenance tüm artifact'lar için üret. — `attest-build-provenance`'ın `subject-path`'i
      artık `*.tar.gz` ve `*.zip`'i birlikte kapsıyor; yapısal test glob listesinin katalogla
      ayrışmasını engelliyor. Gerçek attestation çalışması görülmedi.
- [~] Release gate tüm required platformları görmeden publish etmesin. — birleşik gate dört
      required arşivin (Darwin arm64/x64, Linux x64/arm64) tamamını istiyor; biri eksikken
      `SHA256SUMS does not list <ad>` ile reddediyor (yerel koşumla doğrulandı). Windows,
      `publishedReleaseTargets`'ta ama `requiredReleaseTargets`'ta değil (#46, 9. madde
      kapanana kadar) — mevcutsa tam sıkılıkla doğrulanıyor, yoksa release'i bloklamıyor; gerçek
      tag/CI kanıtı yok.

**2026-09-21 W7-1 dilimi (29c):** Bu maddenin kendi kapanış birimi büyük ölçüde W6-1'in düzeltme
PR'ı tarafından zaten yapılmıştı — `#46` (`requiredReleaseTargets`, beş arşivin SHA256SUMS/
provenance kapsaması, "eksik required arşiv reddedilir ama eksik Windows reddedilmez" testleri)
29c'nin tarif ettiği davranışın kendisi. Bu dilimde kod değişmedi; `docs/12-open-source-
distribution.md` #42/#45/#46'dan sonra hâlâ "iki Darwin, Windows arşivi yok, Linux arşiv
kurulumu devre dışı" diyordu — beş hedefi, required/optional ayrımını ve gerçek runner kanıtının
hâlâ eksik olduğunu yansıtacak şekilde güncellendi. Yukarıdaki "Required küme artık Windows'u
içeriyor" ifadesi yanlıştı (#46 tam tersini yaptı), düzeltildi. Doğrulama: `bun run typecheck &&
bun run lint && bun run test` yerel olarak yeşil (bilinen iki uid-0 hatası hariç); CI hâlâ kota
kesintisinde, gerçek `ubuntu-24.04(-arm)`/`windows-latest` runner kanıtı yok.

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

- [~] standalone zip/exe — `release.yml`'in `verify-windows` job'ı `wtm-windows-x64.zip`'i
      üretip yayımlıyor (W6-1 / 29b); gerçek `windows-latest` runner kanıtı yok (Actions
      kesintisi), yerel kanıt sahte PE fixture'larıyla sınırlı.
- [ ] Scoop
- [ ] WinGet
- [ ] Chocolatey ancak talep oluşursa

npm tüm platformlarda ortak kanal olarak kalabilir.

---

### [x] 31. GitHub Actions badge ve platform CI görünürlüğü

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
- [x] `SUPPORT.md` backend/native/distribution tablosunu içeriyor; minimum OS sürümleri artık
      açık — CI'ın gerçekten çalıştığı imajlar (`macos-15`/`-intel`, `ubuntu-24.04`/`-arm`,
      `windows-latest`) doğrulanmış taban olarak yazıldı, bunun altındaki hiçbir şey denenmedi
      diye belirtildi. Bu bir destek garantisi değil, ölçülenin dürüst sınırı.

**2026-09-21 tamamlandı (W6-4):** Tek matrix workflow (`ci.yml`) kullanıldığından madde metninin
kendi kuralı gereği ("tek matrix workflow kullanılıyorsa tek CI badge yeterli") ayrı canlı
badge'ler eklenmedi — GitHub'ın native workflow badge'i zaten tek bir job'a değil, workflow'un
genel sonucuna bakıyor, bu yüzden "CI macOS / CI Linux / CI Windows" üç ayrı canlı badge olarak
teknik olarak mümkün değil tek workflow'da. Bunun yerine `README.md`'nin "Platform support"
tablosuna ve `SUPPORT.md`'nin tablosuna bir "CI" kolonu eklendi — her satır "Decides the run" /
"Informational only" / "Not run" ile işaretli, `ci.yml`'in win32 job'ının `continue-on-error`
olduğu ve bir release'i bloklamadığı gerçeğini (CLAUDE.md'nin merge şartı) README seviyesinde de
görünür kılıyor. Ayrıca W5-2/W6-1 ile bayatlamış iddialar düzeltildi: "No Linux/Windows release
archive" yerine "release workflow üretiyor ve yayımlıyor ama henüz hiçbir tag bunu taşımadı" —
`README.md`'nin Linux için zaten kullandığı kesin ifade Windows'a da uygulandı.

---

### [x] 32. Examples üç platformda portable olmalı

Mevcut örnekler Unix shell'e veya macOS path'lerine gereksiz bağımlı olmamalı.

**2026-09-14 tamamlandı:** Beş örneğin de `run`/`main`/`worktree` zaten argv array kullanıyordu, hiçbirinde
shell script veya `/tmp`, `/Users/...`, `/home/...`, `$HOME`, `~/`, `C:\` hard-code yoktu (git geçmişinde
de hiç var olmamış — bkz. `git log --follow -p -- examples/`). Eksik olan tek şey Windows path testleriydi;
`scripts/__tests__/examples-portability.test.ts` gerçek `@wtm/core` şemasını ve `resolveTemplate`'i her
örneğe karşı çalıştırıyor: hard-code path taraması, argv-vs-shell tutarlılığı, referans verilen script
dosyalarının varlığı, ve her task `cwd`'sinin hem `node:path/posix` hem `node:path/win32` ile kendi
kök template'inin (`{workspace.root}`/`{worktree.root}`/vb.) içinde kaldığının doğrulanması. Şemada
platforma özel task alanı yok, ve hiçbir örnek shell gerektirmiyor, o yüzden README'lere yeni bir
platform-specific örnek eklenmedi.

Kontrol:

- [x] `examples/minimal`
- [x] `examples/multi-repo`
- [x] `examples/bun-monorepo`
- [x] `examples/docker-compose`
- [x] `examples/polyglot`
- [x] `examples/nextjs`
- [x] `examples/nextjs-hono`
- [x] `examples/python-uv`
- [x] `examples/rust`
- [x] `examples/go`

**Not (2026-09-21, W9-2 / 20):** madde 20'nin beş yeni preset örneği (`nextjs`, `nextjs-hono`,
`python-uv`, `rust`, `go`) eklendiğinde `scripts/__tests__/examples-portability.test.ts`'teki sabit
`exampleDirs` listesi güncellenmemişti; test bunu tam olarak amaçlandığı gibi yakaladı
("the checklist covers every directory under examples/" testi kırmızıydı). Liste beş yeni girdiyle
genişletildi; hepsi zaten argv array kullanıyor, hiçbirinde hard-code path yok, hepsinin `cwd`'si
`{worktree.root}` (veya onun altındaki bir alt dizin) altında kalıyor — ayrı bir düzeltme
gerekmedi.

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

**35a değerlendirmesi (2026-09-21):** beş alandan dördü kapatıldı, biri (resource lifecycle) bir
notla kapatıldı; `events` tamamen yeni kanıtla kapatıldı, o yüzden üstteki satır hâlâ `[ ]`
bırakıldı -- tek bir "hepsi bitti" imzası, aşağıdaki notu okumadan geçilmemesi için.

- **remove lifecycle — zaten kapalı.** PR #11 zaten `### [x] Removal` ve `### [x] Remote safety`
  bölümlerini kapatmıştı (satır 3129-3159); o kanıt burada tekrarlanmıyor. Bu oturum ek bir şey
  bulmadı.
- **cleanup candidates — kapalı, küçük bir boşluk kapatıldı.**
  `packages/core/src/analysis/__tests__/cleanup-ranking.test.ts` (20 test) ve
  `packages/cli/src/__tests__/cleanup-ranking.test.ts` +
  `packages/cli/src/__tests__/cleanup-ranking.scenario.ts` (gerçek Git fixture'ı üzerinden CLI
  seviyesinde) zaten `docs/10-git-safety-worktree-analysis.md`'nin ["Cleanup
  candidates"](docs/10-git-safety-worktree-analysis.md#cleanup-candidates) bölümündeki 7 tier'i
  (readiness, running, unsettled work, persistence strength, idleness, prunable, reclaimable
  estimate), path tie-break'i, `score`'un sıralamayla hiç çelişmediğini ve `BLOCKED`'ın listeden
  düşürülmeden en sona konduğunu tek tek doğruluyordu -- madde 12'nin ("cleanup candidate ranking
  ekle") kendisi de zaten `[x]`. Eksik olan tek şey: tier 5 ("longest since the last WTM activity
  *first*, then since the last commit") için mevcut testlerin hepsi diğer zaman damgasını sabit
  tutuyordu, yani runtime-idleness'ın commit-idleness'a gerçekten üstün geldiğini (ikisi
  çeliştiğinde) hiçbiri kanıtlamıyordu. Yeni test: `cleanup-ranking.test.ts`, "runtime idleness
  outranks commit idleness when the two disagree" -- bir aday yakın zamanda çalıştırılmış ama
  commit'i çok eski, diğeri tam tersi; birincisi hâlâ ikinciden daha kötü (daha az temizlenmeye
  aday) sıralanıyor. `bun test packages/core/src/analysis/__tests__/cleanup-ranking.test.ts`: 20/20
  yeşil. Platform: bu sandbox'ta yalnızca Linux üzerinde çalıştırıldı; çapraz platform CI kanıtı
  iddia edilmiyor (zaten platformdan bağımsız saf mantık).
- **performance gate — zaten kapalı, kod değişikliği gerekmedi.**
  `scripts/__tests__/verify-release.test.ts`, `docs/12-open-source-distribution.md`'nin "Release
  operations" bölümünün tam olarak iddia ettiği üç davranışı ayrı ayrı doğruluyor: "rejects a
  stable release with a performance blocker" (stable + 1 blocker -> reddedilir), "accepts a stable
  release with performance warnings but no blockers" (stable + yalnızca warning -> kabul edilir,
  yani warning hiçbir zaman blocker gibi davranmıyor) ve "accepts a prerelease despite a
  performance blocker" (prerelease + blocker -> kabul edilir, tam muafiyet). Bunlara ek olarak
  "rejects a release without performance results", "a negative report cannot cancel another
  architecture's blocker" ve "reports combined blocker counts exactly even above the safe number
  range" da `verifyPerformance`'ın (`scripts/verify-release.ts`) genel doğruluğunu kanıtlıyor. Bu
  zaten "implementation-detail unit testleri" değil, dokümanın kendi cümleleriyle bire bir eşleşen
  davranış testleri -- madde 4 ve release checklist'teki "Performance workflow/docs parity" satırı
  da zaten `[x]`. `bun test scripts/__tests__/verify-release.test.ts` yeşil.
- **resource lifecycle — büyük ölçüde kapalı; bir dokümantasyon/implementasyon uyuşmazlığı not
  edildi, test boşluğu değil.** `docs/07-process-port-runtime.md`'nin `DISCOVERED -> ALLOCATED ->
  PREPARING -> READY` ve `READY/RUNNING -> ORPHANED -> CLEANING -> REMOVED` akışları ile
  `docs/08-storage-cache-gc.md`'nin storage policy'leri (`shared`/`native-cache`/`clone`/
  `isolated`/`symlink`/`copy`/`ephemeral`/`external`/`ignore`) zaten
  `packages/core/src/resources/__tests__/` altında (`materializer.test.ts`,
  `preparation.test.ts`, `removal.test.ts`, `guard.test.ts`, `guard-lifecycle.scenario.ts` +
  `.test.ts`, `gc.test.ts`, `gc-repository-lease.test.ts`) kapsamlı şekilde test ediliyor; endpoint
  lease'lerin `ORPHANED` worktree'de serbest bırakılması (docs/07 "Endpoint leases") zaten
  `sqlite-store.test.ts`/`.scenario.ts` üzerinden, "port release" satırının (`### [x] Removal`)
  kendi kanıtı. **Not:** docs/07'nin "Cleanup" tablosundaki `containers delete` / `networks
  delete` / `volumes retain by default` satırları için `packages/core`, `packages/adapters` ve
  `packages/daemon` içinde karşılık gelen hiçbir kod bulunamadı (`gc.ts`'teki "container" terimi
  yalnızca GC'nin kendi dosya-sistemi karantina dizinini ifade ediyor, Docker değil) -- bu satırlar
  muhtemelen henüz core'a bağlanmamış adapter-sahipli kaynaklar (ör. Docker Compose) için bir
  kapsam beyanı, `docs/08`'in kendisinin de söylediği gibi ("Adapter-declared disposable build
  outputs and adapter-native dependency cleanup plans are not part of this mode"). Var olmayan bir
  davranış için test yazmak yerine burada açıkça not edildi; bu WTM lifecycle test kapsamının değil,
  ayrı bir implementasyon kapsamının konusu.
- **events — önceden yalnızca `worktree.created` gerçek bir daemon'a karşı kanıtlıydı; şimdi
  8 olayın 8'i de kanıtlı.** `docs/03-configuration-spec.md`'nin Events tablosu sekiz olay
  listeliyor: `workspace.discovered`, `repo.discovered`, `worktree.discovered`, `worktree.created`,
  `worktree.ready`, `worktree.removed`, `runtime.started`, `runtime.stopped`. PR #11
  `worktree.created`'ı gerçek bir daemon'a karşı kanıtlamıştı
  (`create-daemon-running.scenario.ts`); geri kalan yedisi yalnızca
  `packages/daemon/src/__tests__/events.test.ts`'in sahte `LifecycleEventDispatcher` harness'ıyla
  (sahte `store`, sahte `start` -- gerçek supervisor, gerçek soket, gerçek reconcile yok)
  doğrulanıyordu. Yeni `packages/cli/src/__tests__/lifecycle-events-daemon.scenario.ts` +
  `.test.ts`, gerçek `createProductionDaemon` + gerçek `DaemonClient` + gerçek CLI ile kalan
  yedisini tek tek kanıtlıyor: bir workspace/repository'nin ilk reconcile'ı aynı anda
  `workspace.discovered`, `repo.discovered` ve `worktree.discovered`'ı (her biri kendi marker
  task'ını gerçekten çalıştırarak) tetikliyor; `[prepare] mode = "eager"` ile aynı ilk reconcile
  `worktree.ready`'yi de tetikliyor; `wtm start dev` (daemon'un gerçek supervisor'ı üzerinden)
  `runtime.started`'ı, `wtm stop dev` `runtime.stopped`'ı tetikliyor (ve durdurulan sürecin OS'ten
  gerçekten kaybolduğu ayrıca doğrulanıyor); ham bir `git worktree remove` (kasıtlı olarak `wtm
  remove` değil -- o başka bir unit'in alanı ve zaten kendisi hiçbir şey dispatch etmiyor, bir
  sonraki reconcile ediyor) + `reconcile` de `worktree.removed`'ı ana worktree'de tetikliyor, tam
  dokümanda anlatıldığı gibi. Her assertion, ilgili event konfigürasyondan çıkarıldığında testin
  gerçekten kırıldığı elle doğrulandı (ör. `worktree.ready` için `mode: 'lazy'`'a çevrilince test
  zaman aşımıyla başarısız oluyor) -- yani bu testler olayların varlığını değil, gerçekten
  çalıştığını kanıtlıyor. `bun test
  packages/cli/src/__tests__/lifecycle-events-daemon.test.ts`: 1/1 yeşil. Platform: bu sandbox'ta
  yalnızca Linux üzerinde çalıştırıldı; çapraz platform CI kanıtı iddia edilmiyor.

---

# Testing checklist

### [x] Removal

- [x] running managed process
- [x] cleanup failure
- [x] port release
- [x] resource release
- [x] concurrent CLI remove
- [x] CLI + daemon conflict — `daemon-lease-conflict.scenario.ts`, hem aynı operasyon (`remove`
      vs `remove`) hem de farklı operasyon (`remove` vs `gc`) için.
- [x] crash during cleanup
- [x] HEAD changes between checks
- [x] branch changes between checks — `guarded-remove.integration.test.ts`: "rechecks after the
      initial analysis and blocks a worktree switched to another branch". Sibling'inden farkı:
      `HEAD changes` testleri aynı dalda yeni bir commit'in `GIT_HEAD_NOT_REMOTE_PERSISTED`
      blocker'ına takılmasını kanıtlıyor — ikinci Git safety analizi zaten reddediyor, kimlik
      karşılaştırmasına (`assertIdentityUnchanged`, `remove-worktree.ts`) hiç sıra gelmiyor. Bu
      test TOCTOU penceresinde temiz ve kendisi de remote-persisted başka bir dala (`feature/other`)
      geçiyor: ikinci analiz tek başına bunu reddetmezdi (blocker yok), removal'ı durduran yalnızca
      kimlik karşılaştırması — önceden hiçbir testin egzersiz etmediği kod yolu. Beklenen hata:
      `WorktreeAnalysisError`, `context.initial.branchRef` / `context.current.branchRef` farklı.

### [x] Remote safety

- [x] stale local remote ref
- [x] deleted remote branch after refresh
- [x] multiple remotes
- [x] allowed refs config — gerçek Git fixture ile production analyze/remove; son selector
      düzeltmesinden sonra symlink/allowed-ref CLI grubu 11/0.
- [x] detached HEAD
- [x] no upstream
- [x] commit persisted in another remote branch

### [x] Create

- [x] existing branch
- [x] new branch
- [x] conflicting worktree
- [x] partial multi-repo failure — `create-feature-recovery.test.ts`: "a failed member leaves the
      others in place and points at --resume" (`create-feature-recovery.scenario.ts`'in
      `partial` senaryosu). docs/04-cli-reference.md'in tarif ettiği tam davranış: enjekte edilen
      hata `GIT_REPOSITORY_DEGRADED` olarak yüzeyleşiyor, zaten oluşturulmuş iki üye diskte kalıyor
      (`othersOnDisk: [true, true]`, fazlar `APPLIED`), başarısız üye hiçbir şey yazmadan
      (`failedOnDisk: false`, faz `PLANNED`) `wtm create feat/partial --resume` remediation'ıyla
      reddediliyor; aynı dosyadaki sonraki testler bunun `--resume` ile bitirilebildiğini de
      kanıtlıyor. Item 6'nın (`--repos` + recovery) merge'ü bu satırı zaten kapatmıştı, madde
      sadece işaretlenmemişti.
- [x] daemon running — yeni `create-daemon-running.scenario.ts` + `.test.ts`: sahte bir
      `runtimeClient` yerine gerçek `createProductionDaemon`, gerçek soket ve gerçek `DaemonClient`
      ile `wtm create`. `events."worktree.created".tasks` altına bağlı bir görev gerçekten
      çalışıyor (worktree köküne `created.marker` yazıyor) ve `registration: 'daemon'`,
      `warnings: []` dönüyor — daha önce hiçbir testte gerçek bir daemon `[events]`'i uçtan uca
      tetiklemiyordu (`create-feature.test.ts`'teki "a daemon that answers the reconcile registers
      the members" yalnızca `registration` alanını, sahte bir `{ok:true}` cevaplayan
      `runtimeClient` üzerinden kontrol ediyordu — kanca hiç çalışmıyordu).
- [x] daemon stopped
- [x] eager prepare — aynı senaryo: `[prepare] mode = "eager"` + `resources.data` altında, hiçbir
      görev çalıştırılmadan `create` döner dönmez kaynak dizini diskte (`eagerPrepared: true`).
      `create.ts`'in kendi yorumu ("daemon flushes its reconcile queue before it answers") burada
      gerçek bir daemon'a karşı doğrulandı; önceden yalnızca `events.test.ts`'in sahte harness'ı
      (`LifecycleEventDispatcher` birim testi, gerçek CLI/daemon/socket yok) bunu kanıtlıyordu.
- [x] lazy prepare — aynı senaryo: default `lazy` modda aynı kaynak `create` sonrasında (ve 200ms'lik
      bir grace penceresinden sonra) diskte değil (`lazyPrepared: false`) — eager'ın tam zıttı,
      tek bir çalıştırmada karşılaştırmalı olarak kanıtlanıyor.

Doğrulama (2026-09-09): `packages/cli/src/__tests__/create.test.ts` 11/11 başarılı.
Doğrulama (2026-09-14): yukarıdaki dört satır kapatıldı; `create.test.ts`,
`create-feature.test.ts`, `create-feature-recovery.test.ts` ve yeni `create-daemon-running.test.ts`
birlikte 62/62 (bkz. Removal/Create parity turu). `bun run typecheck && bun run lint` temiz.

### [x] Runtime

- [x] daemon restart — added `packages/daemon/src/__tests__/daemon-restart-recovery.scenario.ts`
      (run through `runScenario` from `daemon-restart-recovery.test.ts`), because the existing
      recovery tests in `process-supervisor.test.ts` recover through `new MemoryProcessStore()`, an
      in-memory test double with no foreign-key or persistence semantics — not evidence of a durable
      store surviving a real daemon generation change. The new scenario runs two full
      `createProductionDaemon` lifetimes against the *same* `databasePath` (a real `SQLiteStateStore`
      file on disk — `managed_process_start_reservations.worktree_id` has a real `REFERENCES
      worktrees(id)` foreign key, migration `003-managed-process-reservations.sql`, so this only
      works at all with a real registered Git worktree, unlike the memory double). Lifetime one
      starts two real spawned tasks through the production supervisor/store adapter, then closes
      (control handles only, per `runtime-factory.test.ts`'s "closing the daemon releases control
      handles while a detached task remains live" — both real processes keep running); one task is
      then killed directly (bypassing the supervisor) while no daemon is running at all, simulating
      a crash during the outage. Lifetime two opens a *new* `SQLiteStateStore` and a *new*
      `ManagedProcessSupervisor` on that same file with zero in-memory carryover, and `runtime.start()`
      runs the real startup recovery hook. Asserts the documented outcomes
      (docs/07-process-port-runtime.md): the still-live, identity-matching task is verified and kept
      `RUNNING` (same pid/pgid/start-time, never adopted as a new record or re-spawned), the task
      that exited during the outage is recovered `STOPPED`, and the *same* new supervisor instance
      can still stop the verified-live real process. The narrower `process-supervisor.test.ts` tests
      ("daemon recovery verifies stored identities without adopting them", "reclaims only an expired
      restart lease tied to the exact verified old process", etc.) remain useful unit-level evidence
      for individual recovery branches (crash-mid-start ownership races, expired-lease reclaim) but
      are cited here only for that narrower claim, not for durable-store persistence. Verified with
      `bun test --timeout 60000 packages/daemon/src/__tests__/daemon-restart-recovery.test.ts` (1
      pass). Platform: exercised on macOS (darwin) only in this session; main's win32 CI job
      currently times out at 60 minutes, so Windows behavior for this path is unverified in
      practice, and there is no Linux CI run to point to either — no cross-platform CI evidence is
      implied.
- [x] PID reuse — `packages/daemon/src/__tests__/process-supervisor.test.ts`: "an identity race
      before escalation marks stale and does not send KILL" changes `processStartTime` between the
      TERM and KILL identity checks and asserts no KILL is ever sent; "a stale stored identity
      never signals an unrelated process group" spawns a real unrelated process and stores its
      exact pid/pgid/start-time with a mismatched fingerprint, asserting `stop` reports
      `STALE_IDENTITY` and the unrelated process is left running. Platform: exercised on macOS
      (darwin) only in this session. The code path itself goes through `@wtm/platform`'s
      darwin/linux/windows process backends, but main's win32 CI job currently times out at 60
      minutes, so Windows behavior is unverified in practice; no Linux CI run to point to either —
      no cross-platform CI evidence is implied.
- [x] process group child spawning — `packages/daemon/src/__tests__/process-supervisor.test.ts`:
      "stopping a task terminates its entire owned process group" and "task leader exit leaves the
      anchor and record running until its descendant exits", both against
      `process-group-fixture.scenario.ts`'s real parent-spawns-child fixture (`wtmd -> task group ->
      parent -> child`). Platform: exercised on macOS (darwin) only in this session.
      `hostSignalProcessGroup` delegates to the platform seam (negative-pid signal on POSIX,
      `taskkill /T` on Windows) and a comment in the test file references a prior real
      `windows-latest` CI run, but main's win32 CI job currently times out at 60 minutes, so that
      coverage cannot be confirmed current; no Linux CI run to point to either — no cross-platform
      CI evidence is implied for this change.
- [x] start conflict — `packages/daemon/src/__tests__/process-supervisor.test.ts`: "concurrent
      singleton starts serialize and return one live record" (second call reports `existing: true`,
      no duplicate process) and "restart holds ownership across stop and start against a competing
      supervisor" (a start racing an in-flight restart is refused `RUNTIME_START_FAILED` /
      `reason: START_CONFLICT`); `packages/cli/src/__tests__/readiness-workflow.scenario.ts`
      reproduces the existing-report case end to end through a real CLI, daemon and HTTP
      healthcheck (`wtm start dev --wait` twice; second reports `existing: true`, same process id).
      Platform: exercised on macOS (darwin) only in this session; main's win32 CI job currently
      times out at 60 minutes, so Windows behavior is unverified in practice, and there is no Linux
      CI run to point to either — no cross-platform CI evidence is implied.
- [x] stop conflict — no existing test exercised `RUNTIME_TASK_NOT_RUNNING`, so two tests were
      added to `packages/daemon/src/__tests__/process-supervisor.test.ts`: "a second concurrent stop
      of the same task reports it is not running" (two `stop()` calls issued before either awaits;
      the supervisor's per-task lock serializes them, the first really stops the real spawned
      process and the second is refused `RUNTIME_TASK_NOT_RUNNING`) and "stopping a task with no
      active record reports it is not running" (same code with no prior start at all). Verified
      with `bun test --timeout 60000 packages/daemon/src/__tests__/process-supervisor.test.ts` (45
      pass). Platform: exercised on macOS (darwin) only in this session; main's win32 CI job
      currently times out at 60 minutes, so Windows behavior is unverified in practice, and there
      is no Linux CI run to point to either — no cross-platform CI evidence is implied.
- [x] healthcheck timeout — `packages/daemon/src/__tests__/runtime-readiness.test.ts`: "wait timeout
      returns process evidence and leaves the managed service running" asserts
      `RUNTIME_READINESS_TIMEOUT` / `state: TIMED_OUT` and that the managed process stays `RUNNING`;
      `packages/cli/src/__tests__/readiness-workflow.scenario.ts` reproduces it end to end with a
      real HTTP server that never turns healthy, a real CLI `start --wait --timeout 200ms`, and
      confirms both the daemon's stored state and the OS process stay `RUNNING`/present afterward.
      Platform-neutral (HTTP over loopback; no OS-specific code path).
- [x] log rotation — `packages/daemon/src/__tests__/process-supervisor.test.ts`: "anchor-owned
      writers rotate a fast stream without gaps or duplicate bytes" writes past the configured
      `rotationBytes` bound through a real spawned process and reconstructs the exact byte stream
      from the rotated generations with no gaps or duplicates; the `replacement anchor finishes
      partial retained-generation shift $name idempotently` matrix covers resuming an
      interrupted rotation shift across a supervisor restart. Platform-neutral (file rotation only,
      no OS-specific code path).

### [ ] Platform

- [ ] macOS arm64
- [ ] macOS x64
- [ ] Linux x64
- [ ] Linux arm64
- [ ] Windows x64
- [ ] Windows path/drive-letter tests
- [ ] Windows Named Pipe IPC tests
- [ ] Windows Job Object/process-tree cleanup tests
- [x] Cross-platform config fixture tests — `packages/core/src/config/__tests__/cross-platform-config.test.ts`
      (the four encodings a `wtm.toml` arrives in — LF, CRLF, and each with a leading UTF-8 byte
      order mark — through both the parser and the real loader, with provenance line numbers and
      the deliberate multi-line-string exception pinned) and the pre-existing
      `scripts/__tests__/examples-portability.test.ts` (every published example resolved under a
      POSIX path flavor and a Windows one). Fixture evidence; the last test in the first file is
      host-native and is Windows evidence on the win32 CI leg. Run on Linux only in this session.
- [x] Cross-platform JSON contract parity — `packages/cli/src/commands/__tests__/daemon.test.ts`,
      `the published definition path`: the `wtm daemon install/uninstall/status` envelope built for
      a darwin, a linux and a win32 `PlatformRuntime`, with the published key sets compared
      directly (identical apart from the macOS-only additive `plistPath`), the `ok: false` shape
      and error code compared too, and `label`/`definitionPath` pinned against the
      `docs/04-cli-reference.md` table. Fixture evidence: the platform is injected by id, not
      measured on a real kernel.

### [ ] Distribution / install

- [ ] tarayıcıyla indirilmiş (quarantine damgalı) macOS binary
- [ ] `curl` + `tar` ile kurulum
- [ ] npm `@next` global kurulum
- [x] README quick start'ın temiz bir workspace'te baştan sona çalışması
- [x] `sun_path` sınırını aşan uzun `HOME`
- [x] farklı `HOME`'larda aynı anda iki daemon — yeni `dual-home-daemons.scenario.ts`: iki gerçek
      `createProductionDaemon` (ayrı SQLite state store, ayrı IPC soketi, ayrı log kökü),
      `selectPlatformRuntime` üzerinden yalnızca farklı bir `HOME`'dan türetilmiş, aynı anda
      ayakta. Yol izolasyonu (`containsPath`), eşzamanlı `ping`, birbirinden habersiz `start`/`ps`
      ve bağımsız kapanma (biri kapanınca diğeri hâlâ yanıt veriyor) doğrulanıyor. Linux'ta ölçüldü;
      Windows/macOS'ta ayrı bir ölçüm yok, ama kod platformdan bağımsız (`@wtm/platform` seçimi
      dışında dal yok).
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
