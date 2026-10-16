# Limit tugasa — ishni boshqa Claude bilan davom ettirish

## 1-usul: shu suhbatning o'zini davom ettirish (eng yaxshisi)
Bu sessiya `D:\jarvis 2` papkasida ochilgan, shuning uchun o'sha papkadan davom ettiriladi. PowerShell'da:

```
cd "D:\jarvis 2"
claude2 --resume
```

Ro'yxatdan V2 / web testlar haqidagi sessiyani tanlang. Sessiyalar akkauntlar orasida umumiy.
`claude2` band bo'lsa, `claude3`, `claude4` yoki `claude5` ni ishlating.

## 2-usul: yangi sessiya ochish (suhbat tarixi kerak bo'lmasa)
```
cd "D:\jarvis 2\ai-software-factory-studio"
claude2
```
Keyin shuni yozing:

> docs/v2/CURRENT_STATE.md va docs/v2/NEXT_ACTIONS.md ni o'qi va V2 ishini keyingi qadamdan davom ettir.

Claude bu papkada ochilganda loyihadagi `CLAUDE.md` faylini avtomatik o'qiydi. U yerda barcha qoidalar
va qaysi faylni o'qish kerakligi yozilgan.

## Qayerda nima bor
- `docs/v2/CURRENT_STATE.md` — nima qilindi, nima qolgan, nima sizning ruxsatingizni kutyapti.
- `docs/v2/NEXT_ACTIONS.md` — keyingi qadamlar ketma-ketligi.
- `docs/v2/` — V2 rejasi va barcha hujjatlar.
- `D:\jarvis 2\backups\asf-v1-2026-10-16\` — V1 zaxira nusxasi (o'chirmang).

V1 studiyasi (http://127.0.0.1:4317) bu ishdan ta'sirlanmaydi.
