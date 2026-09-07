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
- [ ] Release dokümantasyonunu güncelle. — bilerek yapılmadı: çevrimiçi ticket lookup gereksinimi
      ("ilk çalıştırma ağ istiyor") ancak notarization gerçekten çalıştığında doğru bir cümle
      olur. Aşağıdaki workaround kaldırma adımıyla aynı değişikliğe ait.
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
- [x] macOS regression yok. — `33657859156`'da her iki macOS bacağı da yeşil; **2026-08-31'den
      beri ilk tam yeşil koşu**. Kırmızılık `48b4bd4`'ten beri sürüyordu ve C1 "doğrulandı" diye
      bildirilirken kimse CI'a bakmamıştı (spec F15). Kalan hata runner'ın `~/Library/LaunchAgents`
      dizinini 0755 olduğu için reddetmesiydi; kural düzeltildi (F16), regresyon değildi.
- [x] Linux x64 CI green. — `33657859156`, üç bacakta da yedi gate'in hepsi koştu, atlanan yok.
- [ ] Linux arm64 build doğrulanıyor.
- [ ] Windows x64 CI green. — **duraklatıldı, 2026-09-06.** Dört düzeltme dalgası (~30 push,
      2026-09-04 – 2026-09-06) gerçek, kanıtlanmış kusurları kapattı (Windows'un ACL-only
      `stat.mode` sentezi, `Get-Acl` arkasındaki PowerShell 5.1/7 modül çakışması, gerçek bir
      Windows daemon'ın kendi data root'unu hiç oluşturamayacağı iki üretim `fileTrust` bağlama
      boşluğu, bir path-normalizasyon hatası). Son gerçek koşu (`34041455473`, `759eb4e`) hâlâ
      1360 testten 98'inin kırmızı olduğunu gösteriyor — çoğunluğu tek bir kümede:
      `process-supervisor.test.ts`'in 27 hatası hâlâ `LOG_SETUP_FAILED` veriyor (dördüncü dalganın
      SID-cache düzeltmesi bunu çözmedi; gerçek ACL diagnostiği trust policy'nin doğru cevap
      verdiğini kanıtlamıştı, yani kök neden hâlâ bulunamadı), ve çoğu CLI entegrasyon testi
      (`adapter`, `gc`, `init`, `production-init`, `remove`, `resolve`, `skill`, `daemon`,
      `full-workflow`, `reconcile-fallback`, `production-commands`) gerçek bir daemon/managed
      process kurduğu için aynı kümeye bağımlı düşüyor. Ayrı, önceden işaretlenmiş bir küme
      (`remove-runtime.test.ts`'in iki-process lease-conflict senaryoları, muhtemelen
      Windows'ta bare `spawn('git', ...)`'in `.cmd`/PATHEXT shim'i üzerinden çözülmemesi) hâlâ
      açık. Karar: kullanıcıyla birlikte, gerisi P0 backlog'unu bekletmesin diye further iterasyon
      şimdilik durduruldu — kalan hatalar sığ olduğu için değil, tam tersi: köklü, henüz
      bulunamamış tek bir savunma hattı sorunu olduğu için, ve 30-60 dk'lık her CI turu bunu hızlı
      kapatmaya yetmiyordu. `supportedPlatforms` `win32`'yi tutuyor, CI leg'i `ci.yml`'de kalıyor
      ve gerçek kırmızısını raporluyor. Detay: `2026-09-04-windows-ci-leg-and-supported-
      platform.md`'nin "Status update, 2026-09-06" bölümü.
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
- [x] README quick start'ın temiz bir workspace'te baştan sona çalışması
- [x] `sun_path` sınırını aşan uzun `HOME`
- [ ] farklı `HOME`'larda aynı anda iki daemon
- [x] `init` sonrası oluşturulan worktree

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
