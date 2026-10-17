# Limit tugasa — ishni boshqa Claude bilan davom ettirish

V2 2026-10-17 da `main` ga qo'shildi (`v2.0.0`) va shu papkadan ishlaydi: `start-studio.cmd` →
http://127.0.0.1:4317.

## 1-usul: shu suhbatning o'zini davom ettirish (eng yaxshisi)
PowerShell'da:

```
cd "D:\jarvis 2"
claude2 --resume
```

Ro'yxatdan V2 haqidagi sessiyani tanlang. Sessiyalar akkauntlar orasida umumiy.
`claude2` band bo'lsa, `claude3`, `claude4` yoki `claude5` ni ishlating.

## 2-usul: yangi sessiya ochish (suhbat tarixi kerak bo'lmasa)

```
cd "D:\jarvis 2\ai-software-factory-studio"
claude2
```
Keyin shuni yozing:

> docs/v2/CURRENT_STATE.md va docs/v2/NEXT_ACTIONS.md ni o'qi va keyingi qadamdan davom ettir.

Claude bu papkada ochilganda loyihadagi `CLAUDE.md` faylini avtomatik o'qiydi. U yerda barcha qoidalar
va qaysi faylni o'qish kerakligi yozilgan.

## Qayerda nima bor
- `docs/v2/CURRENT_STATE.md` — nima qilindi, nima qolgan, nima sizning ruxsatingizni kutyapti.
- `docs/v2/NEXT_ACTIONS.md` — keyingi qadamlar ketma-ketligi.
- `docs/v2/WINDOWS_LAUNCH.md` — ishga tushirish va orqaga qaytarish (rollback).
- `D:\jarvis 2\backups\asf-v1-2026-10-16\` va `D:\jarvis 2\backups\asf-v1-final-2026-10-17\` — V1 zaxira
  nusxalari (o'chirmang).
