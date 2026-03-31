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

- `/admin` - admin panel (Statistika, Foydalanuvchilar, To'lovlar, Xabarlar, Majburiy kanallar, link/rekvizit sozlash)
- `/setgoal 5` - necha referral kerakligini o'rnatadi
- `/setpayment` - to'lov rekvizitlarini 3 bosqichda sozlaydi (karta -> karta egasi -> summa)
- `/addrequired -1001234567890 [@username|https://t.me/...]` - majburiy Telegram kanal qo'shish
- `/addexternal https://instagram.com/yourpage [nomi]` - majburiy external havola qo'shish (tekshirilmaydi)
- `/removerequired -1001234567890` - majburiy kanalni inactive qilish
- `/setprivate -1001234567890` - yopiq kanal ID (bot dinamik invite link yaratadi)
- `/setprivatelink https://t.me/+XXXX` - yopiq kanalning tayyor linkini o'rnatish
- `/setarchive -1001234567890` - database kanal ID (cheklar va poster log uchun)
- `/setdbchannel -1001234567890` - database kanal ID ni alias buyruq bilan o'rnatish
- `/setposter` - referral poster rasmini biriktirish (photo yuboriladi)
- `/status` - joriy sozlamalar holati
- `/payapprove <id>` - to'lovni tasdiqlash
- `/payreject <id> [sabab]` - to'lovni rad etish
- `/msgreply <userId>` - userga support javobi yozish

## User oqimi

1. `/start`
2. User avval majburiy Telegram kanallarga a'zo bo'ladi va `✅ A'zo bo'ldim` tugmasini bosadi
3. Agar admin external havolalar qo'shgan bo'lsa (Instagram/YouTube), ular ham shu gate oynasida ko'rinadi, lekin bot ularni tekshirmaydi
4. Obuna tasdiqlangach, user menyusi ochiladi:
   - `📊 Mening statistikam`
   - `🔗 Referral link`
   - `👥 Mening takliflarim`
   - `🔒 Yopiq kanal linki`
   - `💳 To'lov qilish`
   - `💬 Qo'llab-quvvatlash`
5. `Referral link` bo'limida bot referral matnini yuboradi va tagida `♻️ Ulashish` tugmasi chiqadi
6. Admin poster biriktirgan bo'lsa, shu referral matni rasm bilan yuboriladi
7. Referral soni maqsadga yetsa yoki to'lov tasdiqlansa, yopiq kanal linki yuboriladi
8. User hali huquqqa ega bo'lmasa, bot 2 variantni ko'rsatadi: referral yoki to'lov

## Payments oqimi

- Admin panelda `To'lov sozlash` (yoki `/setpayment`) orqali karta raqami, karta egasi va summani saqlaydi
- User `💳 To'lov qilish`ni bosganda karta, karta egasi va summa ko'rsatiladi
- User `📤 Chekni yuborish` tugmasini bosadi, bot chek rasmini kutadi (`Bekor qilish` ham mavjud)
- Chek `PENDING` holatda saqlanadi
- Bot chekni adminlarga yuboradi va inline tugmalar bilan `Tasdiqlash/Rad etish` beradi
- Bot chek rasmini database kanalga ham tashlaydi
- Admin yangi referral posteri biriktirsa, poster ham database kanalga log qilinadi
- Admin `To'lovlar` bo'limidan ham tasdiqlaydi/rad etadi
- Tasdiqlansa userga ruxsat beriladi
- Rad etilsa userga supportga yozish xabari qaytariladi
- Barcha cheklar ixtiyoriy database kanalga ham yuboriladi

## Support oqimi

- User `Qo'llab-quvvatlash`ni bosib xabar yuboradi
- Admin `Xabarlar` bo'limidan user tarixini ko'radi
- Admin userga bot orqali javob yozadi

## Muhim eslatma

Bot yopiq kanalga admin sifatida qo'shilgan bo'lishi kerak. Majburiy kanallar va yopiq kanalga botda kerakli huquqlar bo'lishi shart.
