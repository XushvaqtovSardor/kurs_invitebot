# Kanalga Taklif Bot (NestJS + Grammy + Prisma)

Bu loyiha quyidagi oqimni bajaradi:
- User `/start` bosadi
- Majburiy kanallarga a'zo bo'ladi
- Referral orqali odam taklif qiladi yoki to'lov qilib ruxsat oladi
- Admin to'lov cheklarini ko'rib tasdiqlaydi/rad etadi
- Support xabarlar admin paneldan ko'rilib javob beriladi
- Yopiq kanalga join request bo'lsa, bot faqat huquqli userlarni avtomatik tasdiqlaydi

## Texnologiyalar

- NestJS
- Grammy
- Prisma 7 + PostgreSQL (`@prisma/adapter-pg`)

## 1) O'rnatish

```bash
pnpm install
```

## 2) Muhit o'zgaruvchilari

`.env` faylini to'ldiring:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/prime_kimyo?schema=public"
BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
BOT_USERNAME="your_bot_username"
ADMIN_IDS="123456789,987654321"
```

`ADMIN_IDS` ichiga vergul bilan admin Telegram ID larini yozing.
`BOT_USERNAME` ga Telegram username ni `@` belgisiz va bo'shliqsiz yozing.

## 3) Prisma

```bash
pnpm prisma:generate
pnpm prisma:migrate
```

## 4) Ishga tushirish

```bash
pnpm start:dev
```

## Admin buyruqlari

- `/admin` - admin panel (Payments, Xabarlar)
- `/setgoal 5` - necha referral kerakligini o'rnatadi
- `/setpayment 8600123412341234|25000` - karta va summa
- `/addrequired -1001234567890` - majburiy kanal qo'shish
- `/removerequired -1001234567890` - majburiy kanalni inactive qilish
- `/setprivate -1001234567890` - yopiq kanal ID
- `/setarchive -1001234567890` - barcha cheklar log bo'ladigan kanal ID
- `/status` - joriy sozlamalar holati

## User oqimi

1. `/start`
2. Bot asosiy menyuni beradi:
   - Majburiy kanallarni tekshirish
   - To'lov orqali ulanish
   - Mening referalim
   - Qo'llab-quvvatlash
3. User barcha majburiy kanallarga a'zo bo'lsa, referral hisobi ishlaydi
4. Referral soni maqsadga yetsa yoki to'lov tasdiqlansa, yopiq kanal join link yuboriladi
5. Join requestda bot eligibility tekshiradi va mos bo'lsa approve qiladi

## Payments oqimi

- User to'lov qiladi va chek rasmini yuboradi
- Chek `PENDING` holatda saqlanadi
- Admin `Payments` bo'limidan tasdiqlaydi/rad etadi
- Tasdiqlansa userga ruxsat beriladi
- Rad etilsa userga supportga yozish xabari qaytariladi
- Barcha cheklar ixtiyoriy archive kanalga ham yuboriladi

## Support oqimi

- User `Qo'llab-quvvatlash`ni bosib xabar yuboradi
- Admin `Xabarlar` bo'limidan user tarixini ko'radi
- Admin userga bot orqali javob yozadi

## Muhim eslatma

Bot yopiq kanalga admin sifatida qo'shilgan bo'lishi kerak. Majburiy kanallar va yopiq kanalga botda kerakli huquqlar bo'lishi shart.
