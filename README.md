# Huawei HLS Capture PoC

Proof-of-concept Node.js tool untuk mengamati traffic browser yang sah dari akun Huawei Talent Online Learning yang sudah login manual, lalu menyimpan kandidat URL video HLS.

Tool ini tidak melakukan bypass autentikasi, tidak membaca cookie Chrome langsung, tidak reverse engineering API private, tidak mengunduh video, tidak memodifikasi request, dan tidak menangani DRM.

## Alasan Desain

1. `launchPersistentContext` dipakai agar Chromium Playwright memiliki profile persisten. Setelah login manual sekali, session dapat dipakai ulang dari folder `playwright-profile/`.
2. Profile Playwright dibuat terpisah dari Chrome utama supaya tidak perlu membaca cookie browser personal dan lebih aman untuk eksperimen.
3. Network dipantau memakai event resmi Playwright `request` dan `response`. Script hanya mengamati traffic browser yang terjadi dari halaman yang dibuka.
4. Kandidat HLS dideteksi dari URL yang mengandung `.m3u8` atau response `content-type` HLS: `application/vnd.apple.mpegurl` dan `application/x-mpegURL`.
5. Deduplikasi memakai `Set` di memory dan isi lama `urls.txt` dibaca saat startup, sehingga restart script tidak menulis URL yang sama lagi.
6. `urls.txt` hanya berisi URL unik agar mudah diproses berikutnya. `urls.log` menyimpan timestamp dan metadata singkat untuk audit.
7. Mode debug dibuat opsional karena halaman modern dapat menghasilkan sangat banyak request dan response.

## Struktur Project

```text
huawei-hls-capture/
  package.json
  README.md
  .gitignore
  src/
    index.js
```

File runtime yang akan muncul:

```text
playwright-profile/  # profile Chromium persisten
urls.txt             # URL HLS unik
urls.log             # log timestamp tiap URL baru
videos.json          # metadata lesson dan URL HLS per lesson
```

## Kebutuhan

1. Windows 11
2. Node.js 18 atau lebih baru
3. Internet access
4. Akun Huawei Talent Online Learning yang login manual melalui browser Playwright

## Instalasi

```powershell
cd C:\Users\adima\OneDrive\Dokumen\Github\huawei-hls-capture
npm install
npx playwright install chromium
```

## Cara Menjalankan

Jalankan dengan URL course Huawei:

```powershell
npm start -- --url "https://contoh-url-course-huawei"
```

Alur default manual:

1. Jalankan `npm start`.
2. Browser Chromium Playwright terbuka.
3. Jika belum login, login manual dulu di browser itu.
4. Jika sudah login, pastikan halaman course terbuka dan siap.
5. Tekan Enter di CMD saat prompt muncul.
6. Klik lesson/video manual satu per satu di browser.
7. Setiap `.m3u8` yang terlihat dari network browser akan masuk ke `urls.txt` dan `urls.log`.

Script akan terus memonitor network sampai dihentikan dengan `Ctrl+C`.

Jika tidak mau menunggu prompt Enter dan ingin monitoring langsung aktif:

```powershell
npm start -- --url "https://contoh-url-course-huawei" --no-wait
```

## Mode Auto Lesson

Mode ini mencoba meng-enumerasi lesson dari UI course, klik lesson satu per satu, menunggu player memuat video, lalu menyimpan `.m3u8` yang terlihat dari traffic browser normal.

```powershell
npm start -- --url "https://contoh-url-course-huawei" --auto-lessons
```

Dengan debug:

```powershell
npm run start:debug -- --url "https://contoh-url-course-huawei" --auto-lessons
```

Strategi mode auto:

1. Membuka halaman course dengan persistent profile yang sama.
2. Expand elemen visible dengan `aria-expanded="false"` untuk membuka module/section.
3. Scroll halaman dan container umum untuk memicu lazy loading.
4. Mengambil kandidat lesson dari elemen clickable yang visible seperti `a`, `button`, role `button`, role `treeitem`, role `listitem`, dan elemen bertabindex.
5. Klik kandidat lesson melalui UI normal, bukan memanggil endpoint internal.
6. Menunggu player/request video muncul dalam capture window.
7. Retry lesson jika `.m3u8` belum ditemukan.
8. Menulis progress setelah setiap lesson supaya bisa resume.

Resume aktif secara default. Jika proses berhenti, jalankan command yang sama dan lesson dengan status `completed` akan dilewati.

Untuk memulai ulang metadata dari awal:

```powershell
npm start -- --url "https://contoh-url-course-huawei" --auto-lessons --no-resume
```

Tuning umum:

```powershell
npm start -- --url "https://contoh-url-course-huawei" --auto-lessons --max-attempts 3 --capture-window-ms 30000 --lesson-load-timeout-ms 8000
```

## Mode Debug

```powershell
npm run start:debug -- --url "https://contoh-url-course-huawei"
```

Mode debug menampilkan:

1. request URL
2. response URL
3. response status
4. response `content-type`

Alternatif via environment variable:

```powershell
$env:DEBUG_HLS_CAPTURE="1"
npm start -- --url "https://contoh-url-course-huawei"
```

## Opsi CLI

```text
--url <url>             Huawei course page to open
--debug                 Print request URL, response URL, status, and content-type
--auto-lessons          Discover and click lesson candidates automatically
--no-wait               Do not wait for Enter before manual monitoring
--resume                Resume from videos.json, default: enabled
--no-resume             Ignore existing videos.json and rebuild state
--max-attempts <n>      Retry attempts per lesson, default: 3
--capture-window-ms <n> Wait time for HLS after clicking lesson, default: 20000
--lesson-load-timeout-ms <n> Wait after clicking lesson before play/capture, default: 5000
--profile-dir <path>    Persistent browser profile directory, default: playwright-profile
--channel <name>        Optional browser channel, for example: chrome or msedge
```

Contoh memakai Microsoft Edge channel jika tersedia:

```powershell
npm start -- --channel msedge --url "https://contoh-url-course-huawei"
```

## Output

Saat URL baru ditemukan, console menampilkan:

```text
[hls] 2026-06-04T14:00:00.000Z https://example/video/master.m3u8
```

`urls.txt`:

```text
https://example/video/master.m3u8
```

`urls.log`:

```text
[2026-06-04T14:00:00.000Z] source=response status=200 content-type=application/vnd.apple.mpegurl https://example/video/master.m3u8
```

`videos.json`:

```json
{
  "courseUrl": "https://e.huawei.com/...",
  "createdAt": "2026-06-04T14:00:00.000Z",
  "updatedAt": "2026-06-04T14:10:00.000Z",
  "lessons": [
    {
      "id": "lesson-123456",
      "title": "Lesson Title",
      "lessonUrl": "https://e.huawei.com/...",
      "status": "completed",
      "attempts": 1,
      "m3u8Urls": [
        "https://example/video/master.m3u8"
      ],
      "firstFoundAt": "2026-06-04T14:02:00.000Z",
      "lastFoundAt": "2026-06-04T14:02:00.000Z",
      "lastTriedAt": "2026-06-04T14:01:45.000Z",
      "completedAt": "2026-06-04T14:02:03.000Z",
      "error": null
    }
  ]
}
```

## Catatan Operasional

1. Jika tidak ada `.m3u8` muncul, kemungkinan video belum dimainkan atau player belum memuat playlist HLS.
2. Mode auto lesson memakai selector heuristik karena UI Huawei bisa berubah. Jika discovery tidak lengkap, expand module/section manual lalu rerun.
3. URL HLS kadang bersifat sementara atau terikat session akun.
4. Jika platform memakai DRM atau token ketat, tool ini tetap hanya mencatat URL yang terlihat dari browser.
5. Tool tidak melakukan reverse engineering API private dan tidak mengakses endpoint yang tidak dipakai browser normal.

## Troubleshooting

Jika browser tidak terbuka:

```powershell
npx playwright install chromium
```

Jika navigation timeout muncul, browser tetap dibiarkan terbuka. Login manual atau reload halaman dari browser.

Jika output debug terlalu ramai, gunakan mode normal:

```powershell
npm start -- --url "https://contoh-url-course-huawei"
```
