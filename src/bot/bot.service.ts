import {
    ChannelType,
    MessageDirection,
    PaymentStatus,
    User,
    UserState,
} from '@prisma/client';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InlineKeyboard, Keyboard } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';

const SETTING_REFERRAL_GOAL = 'referral_goal';
const SETTING_PAYMENT_CARD = 'payment_card';
const SETTING_PAYMENT_AMOUNT = 'payment_amount';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BotService.name);
    private readonly adminReplyTargets = new Map<string, number>();
    private bot: Bot<Context> | null = null;

    constructor(
        private readonly configService: ConfigService,
        private readonly prisma: PrismaService,
    ) { }

    async onModuleInit(): Promise<void> {
        const token = this.configService.get<string>('BOT_TOKEN')?.trim();
        if (!token) {
            this.logger.warn('BOT_TOKEN topilmadi, bot ishga tushirilmadi.');
            return;
        }

        this.bot = new Bot<Context>(token);
        this.registerHandlers();

        this.bot.catch((err) => {
            this.logger.error(`Bot error: ${err.message}`, err);
        });

        await this.bot.start({ onStart: () => this.logger.log('Telegram bot ishga tushdi.') });
    }

    async onModuleDestroy(): Promise<void> {
        await this.bot?.stop();
    }

    private registerHandlers(): void {
        if (!this.bot) {
            return;
        }

        // User commands
        this.bot.command('start', async (ctx) => {
            if (!ctx.from) return;
            const payload = ctx.message?.text?.split(' ')[1]?.trim();
            const user = await this.getOrCreateUser(ctx.from, payload);
            await this.ensureAccessIfEligible(user.id);

            await ctx.reply(
                'Assalomu alaykum. Kanalga kirish uchun 2 yo‘l bor:\n1) Odam taklif qilish\n2) To‘lov qilish',
                { reply_markup: this.userMenuKeyboard() },
            );
            await this.sendReferralInfo(ctx, user);
        });

        this.bot.command('menu', async (ctx) => {
            await ctx.reply('Asosiy menyu:', { reply_markup: this.userMenuKeyboard() });
        });

        this.bot.command('check', async (ctx) => {
            await this.handleCheck(ctx);
        });

        this.bot.command('ref', async (ctx) => {
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.sendReferralInfo(ctx, user);
        });

        this.bot.command('pay', async (ctx) => {
            await this.handlePay(ctx);
        });

        this.bot.command('support', async (ctx) => {
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.prisma.user.update({
                where: { id: user.id },
                data: { state: UserState.AWAITING_SUPPORT_MESSAGE },
            });
            await ctx.reply('Muammoingizni bitta xabarda yozib yuboring.');
        });

        // Admin menu entry
        this.bot.command('admin', async (ctx) => {
            if (!ctx.from || !this.isAdmin(ctx.from.id)) {
                await ctx.reply('Siz admin emassiz.');
                return;
            }
            await ctx.reply('Admin panel:', { reply_markup: this.adminMenuKeyboard() });
        });

        // Admin settings
        this.bot.command('setgoal', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const valueRaw = ctx.message?.text?.split(' ')[1];
            const value = Number(valueRaw);
            if (!Number.isInteger(value) || value <= 0) {
                await ctx.reply('Format: /setgoal 5');
                return;
            }
            await this.setSetting(SETTING_REFERRAL_GOAL, String(value));
            await ctx.reply(`Referral maqsadi ${value} ga o‘rnatildi.`);
        });

        this.bot.command('setpayment', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const args = ctx.message?.text?.replace('/setpayment', '').trim() ?? '';
            const [card, amountRaw] = args.split('|').map((s) => s?.trim());
            const amount = Number(amountRaw);
            if (!card || !Number.isFinite(amount) || amount <= 0) {
                await ctx.reply('Format: /setpayment 8600123412341234|25000');
                return;
            }
            await this.setSetting(SETTING_PAYMENT_CARD, card);
            await this.setSetting(SETTING_PAYMENT_AMOUNT, String(amount));
            await ctx.reply('To‘lov rekvizitlari saqlandi.');
        });

        this.bot.command('addrequired', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const chatId = ctx.message?.text?.split(' ')[1]?.trim();
            if (!chatId) {
                await ctx.reply('Format: /addrequired -1001234567890');
                return;
            }
            await this.prisma.channel.upsert({
                where: { telegramId: chatId },
                update: { type: ChannelType.REQUIRED, isActive: true },
                create: { telegramId: chatId, type: ChannelType.REQUIRED, isActive: true },
            });
            await ctx.reply('Majburiy kanal qo‘shildi yoki yangilandi.');
        });

        this.bot.command('removerequired', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const chatId = ctx.message?.text?.split(' ')[1]?.trim();
            if (!chatId) {
                await ctx.reply('Format: /removerequired -1001234567890');
                return;
            }
            await this.prisma.channel.updateMany({
                where: { telegramId: chatId, type: ChannelType.REQUIRED },
                data: { isActive: false },
            });
            await ctx.reply('Majburiy kanal o‘chirildi (inactive).');
        });

        this.bot.command('setprivate', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const chatId = ctx.message?.text?.split(' ')[1]?.trim();
            if (!chatId) {
                await ctx.reply('Format: /setprivate -1001234567890');
                return;
            }
            await this.prisma.channel.updateMany({
                where: { type: ChannelType.PRIVATE_ACCESS },
                data: { isActive: false },
            });
            await this.prisma.channel.upsert({
                where: { telegramId: chatId },
                update: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
                create: { telegramId: chatId, type: ChannelType.PRIVATE_ACCESS, isActive: true },
            });
            await ctx.reply('Yopiq kanal saqlandi.');
        });

        this.bot.command('setarchive', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const chatId = ctx.message?.text?.split(' ')[1]?.trim();
            if (!chatId) {
                await ctx.reply('Format: /setarchive -1001234567890');
                return;
            }
            await this.prisma.channel.updateMany({
                where: { type: ChannelType.RECEIPT_ARCHIVE },
                data: { isActive: false },
            });
            await this.prisma.channel.upsert({
                where: { telegramId: chatId },
                update: { type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
                create: { telegramId: chatId, type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
            });
            await ctx.reply('Cheklar arxivi kanal ID saqlandi.');
        });

        // Admin info and payments
        this.bot.command('status', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const goal = await this.getReferralGoal();
            const card = (await this.getSetting(SETTING_PAYMENT_CARD)) ?? 'yo‘q';
            const amount = (await this.getSetting(SETTING_PAYMENT_AMOUNT)) ?? 'yo‘q';
            const requiredCount = await this.prisma.channel.count({
                where: { type: ChannelType.REQUIRED, isActive: true },
            });
            const privateChannel = await this.prisma.channel.findFirst({
                where: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
            });
            await ctx.reply(
                [
                    `Referral maqsad: ${goal}`,
                    `Majburiy kanal soni: ${requiredCount}`,
                    `To‘lov karta: ${card}`,
                    `To‘lov summa: ${amount}`,
                    `Yopiq kanal: ${privateChannel?.telegramId ?? 'o‘rnatilmagan'}`,
                ].join('\n'),
            );
        });

        this.bot.command('admininfo', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showAdminInfo(ctx);
        });

        this.bot.command('payments', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const statusArg = ctx.message?.text?.split(' ')[1]?.toUpperCase();
            const status =
                statusArg === 'PENDING' || statusArg === 'APPROVED' || statusArg === 'REJECTED'
                    ? (statusArg as PaymentStatus)
                    : PaymentStatus.PENDING;
            const limitRaw = ctx.message?.text?.split(' ')[2];
            await this.showPayments(ctx, status, limitRaw);
        });

        this.bot.command('paydetail', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const idRaw = ctx.message?.text?.split(' ')[1];
            const paymentId = Number(idRaw);
            if (!Number.isInteger(paymentId)) {
                await ctx.reply('Format: /paydetail 12');
                return;
            }
            const payment = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { user: true },
            });
            if (!payment) {
                await ctx.reply('To‘lov topilmadi.');
                return;
            }
            const text = [
                `To‘lov #${payment.id}`,
                `User: @${payment.user.username ?? 'username yo‘q'}`,
                `TG ID: ${payment.user.telegramId}`,
                `Summa: ${payment.amount}`,
                `Status: ${payment.status}`,
                `Karta: ${payment.cardNumber}`,
                payment.rejectionReason ? `Sabab: ${payment.rejectionReason}` : undefined,
            ]
                .filter(Boolean)
                .join('\n');
            await ctx.reply(text);
        });

        this.bot.command('payapprove', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const idRaw = ctx.message?.text?.split(' ')[1];
            const paymentId = Number(idRaw);
            if (!Number.isInteger(paymentId)) {
                await ctx.reply('Format: /payapprove 12');
                return;
            }
            const payment = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { user: true },
            });
            if (!payment || payment.status !== PaymentStatus.PENDING) {
                await ctx.reply('To‘lov holati mos emas yoki topilmadi.');
                return;
            }
            await this.prisma.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.APPROVED,
                    rejectionReason: null,
                    reviewedByAdminId: String(ctx.from?.id ?? ''),
                },
            });
            await this.prisma.user.update({
                where: { id: payment.userId },
                data: { accessGranted: true },
            });
            await ctx.reply(`To‘lov #${payment.id} tasdiqlandi.`);
            await this.notifyUser(payment.user.telegramId, 'To‘lovingiz tasdiqlandi.');
            await this.sendPrivateChannelAccessByUser(payment.user);
        });

        this.bot.command('payreject', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const parts = (ctx.message?.text ?? '').split(' ');
            const idRaw = parts[1];
            const paymentId = Number(idRaw);
            const reason = parts.slice(2).join(' ').trim() || 'To‘lov tasdiqlanmadi';
            if (!Number.isInteger(paymentId)) {
                await ctx.reply('Format: /payreject 12 [sabab]');
                return;
            }
            const payment = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { user: true },
            });
            if (!payment || payment.status !== PaymentStatus.PENDING) {
                await ctx.reply('To‘lov holati mos emas yoki topilmadi.');
                return;
            }
            await this.prisma.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.REJECTED,
                    rejectionReason: reason,
                    reviewedByAdminId: String(ctx.from?.id ?? ''),
                },
            });
            await ctx.reply(`To‘lov #${payment.id} rad etildi.`);
            await this.notifyUser(
                payment.user.telegramId,
                `To‘lov amalga oshirilmadi: ${reason}. Qo‘llab-quvvatlash xizmatiga yozing.`,
            );
        });

        // Support/admin messaging
        this.bot.command('supportlist', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showSupportList(ctx);
        });

        this.bot.command('userstat', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const arg = ctx.message?.text?.split(' ')[1];
            if (!arg) {
                await ctx.reply('Format: /userstat <userId|telegramId>');
                return;
            }
            const byId = Number(arg);
            const user = Number.isInteger(byId)
                ? await this.prisma.user.findUnique({ where: { id: byId } })
                : await this.prisma.user.findUnique({ where: { telegramId: arg } });
            if (!user) {
                await ctx.reply('User topilmadi.');
                return;
            }
            const text = [
                `ID: ${user.id}`,
                `TG: ${user.telegramId}`,
                `Username: @${user.username ?? 'yo‘q'}`,
                `Takliflar: ${user.invitedCount}`,
                `Access: ${user.accessGranted ? 'ha' : 'yo‘q'}`,
                `State: ${user.state}`,
            ].join('\n');
            await ctx.reply(text);
        });

        this.bot.command('messages', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showSupportList(ctx, 20);
        });

        this.bot.command('msguser', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const idRaw = ctx.message?.text?.split(' ')[1];
            const userId = Number(idRaw);
            if (!Number.isInteger(userId)) {
                await ctx.reply('Format: /msguser 5');
                return;
            }
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) {
                await ctx.reply('User topilmadi.');
                return;
            }
            const historyDesc = await this.prisma.supportMessage.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 30,
            });
            if (!historyDesc.length) {
                await ctx.reply('Xabarlar topilmadi.');
                return;
            }
            const history = [...historyDesc].reverse();
            const body = history
                .map((item) => {
                    const sender = item.direction === MessageDirection.USER ? 'USER' : 'ADMIN';
                    const ts = item.createdAt.toLocaleString('uz-UZ');
                    return `${sender} (${ts}): ${item.text}`;
                })
                .join('\n\n');
            await ctx.reply(body);
        });

        this.bot.command('msgreply', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            const idRaw = ctx.message?.text?.split(' ')[1];
            const userId = Number(idRaw);
            if (!Number.isInteger(userId)) {
                await ctx.reply('Format: /msgreply 5');
                return;
            }
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) {
                await ctx.reply('User topilmadi.');
                return;
            }
            const adminId = String(ctx.from?.id);
            this.adminReplyTargets.set(adminId, userId);
            await ctx.reply('Endi javob matnini yuboring.');
        });

        // Reply keyboards for users/admins
        this.bot.hears('Majburiy kanallar', async (ctx) => this.handleCheck(ctx));
        this.bot.hears('To‘lov', async (ctx) => this.handlePay(ctx));
        this.bot.hears('Referal', async (ctx) => {
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.sendReferralInfo(ctx, user);
        });
        this.bot.hears('Qo‘llab-quvvatlash', async (ctx) => {
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.prisma.user.update({
                where: { id: user.id },
                data: { state: UserState.AWAITING_SUPPORT_MESSAGE },
            });
            await ctx.reply('Muammoingizni bitta xabarda yozib yuboring.');
        });

        // Admin reply-keyboard shortcuts
        this.bot.hears('🧾 Payments', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showPayments(ctx, PaymentStatus.PENDING);
        });
        this.bot.hears('💬 Support', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showSupportList(ctx);
        });
        this.bot.hears('📊 Statistika', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showAdminInfo(ctx);
        });

        // Inline keyboards
        this.bot.callbackQuery('main:check', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handleCheck(ctx);
        });

        this.bot.callbackQuery('main:ref', async (ctx) => {
            await ctx.answerCallbackQuery();
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.sendReferralInfo(ctx, user);
        });

        this.bot.callbackQuery('main:pay', async (ctx) => {
            await ctx.answerCallbackQuery();
            const card = await this.getSetting(SETTING_PAYMENT_CARD);
            const amount = await this.getSetting(SETTING_PAYMENT_AMOUNT);
            if (!card || !amount) {
                await ctx.reply('To‘lov ma’lumotlari hali admin tomonidan kiritilmagan.');
                return;
            }
            await ctx.reply(
                `To‘lov qilish uchun:\nKarta: ${card}\nSumma: ${amount}\n\nTo‘lov qilgach, chek rasmini yuboring.`,
                { reply_markup: new InlineKeyboard().text('Chek yuborish', 'pay:send_receipt') },
            );
        });

        this.bot.callbackQuery('pay:send_receipt', async (ctx) => {
            await ctx.answerCallbackQuery();
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.prisma.user.update({
                where: { id: user.id },
                data: { state: UserState.AWAITING_RECEIPT },
            });
            await ctx.reply('Endi chek rasmini yuboring (photo).');
        });

        this.bot.callbackQuery('main:support', async (ctx) => {
            await ctx.answerCallbackQuery();
            if (!ctx.from) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) {
                await ctx.reply('/start ni qayta bosing.');
                return;
            }
            await this.prisma.user.update({
                where: { id: user.id },
                data: { state: UserState.AWAITING_SUPPORT_MESSAGE },
            });
            await ctx.reply('Muammoingizni bitta xabarda yozib yuboring.');
        });

        // Admin callback flows for payments/messages
        this.bot.callbackQuery('admin:payments', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await ctx.reply('Payments bo‘limi:', {
                reply_markup: new InlineKeyboard()
                    .text('Kutilmoqda', 'pay:list:PENDING')
                    .row()
                    .text('Qabul qilinganlar', 'pay:list:APPROVED')
                    .row()
                    .text('Rad etilganlar', 'pay:list:REJECTED'),
            });
        });

        this.bot.callbackQuery(/^pay:list:(PENDING|APPROVED|REJECTED)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const status = ctx.match[1] as PaymentStatus;
            const payments = await this.prisma.payment.findMany({
                where: { status },
                include: { user: true },
                orderBy: { createdAt: 'desc' },
                take: 20,
            });
            if (!payments.length) {
                await ctx.reply('Bu holatda to‘lovlar topilmadi.');
                return;
            }
            const keyboard = new InlineKeyboard();
            for (const payment of payments) {
                keyboard.text(
                    `#${payment.id} @${payment.user.username ?? payment.user.telegramId}`,
                    `pay:item:${payment.id}`,
                );
                keyboard.row();
            }
            await ctx.reply(`${status} ro‘yxati:`, { reply_markup: keyboard });
        });

        this.bot.callbackQuery(/^pay:item:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const paymentId = Number(ctx.match[1]);
            const payment = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { user: true },
            });
            if (!payment) {
                await ctx.reply('To‘lov topilmadi.');
                return;
            }
            const text = [
                `To‘lov #${payment.id}`,
                `User: @${payment.user.username ?? 'username yo‘q'}`,
                `TG ID: ${payment.user.telegramId}`,
                `Summa: ${payment.amount}`,
                `Status: ${payment.status}`,
                `Karta: ${payment.cardNumber}`,
            ].join('\n');
            if (payment.status === PaymentStatus.PENDING) {
                await ctx.reply(text, {
                    reply_markup: new InlineKeyboard()
                        .text('Tasdiqlash', `pay:approve:${payment.id}`)
                        .row()
                        .text('Rad etish', `pay:reject:${payment.id}`),
                });
                return;
            }
            await ctx.reply(text);
        });

        this.bot.callbackQuery(/^pay:approve:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const paymentId = Number(ctx.match[1]);
            const payment = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { user: true },
            });
            if (!payment || payment.status !== PaymentStatus.PENDING) {
                await ctx.reply('To‘lov holati mos emas.');
                return;
            }
            await this.prisma.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.APPROVED,
                    rejectionReason: null,
                    reviewedByAdminId: String(ctx.from?.id ?? ''),
                },
            });
            await this.prisma.user.update({
                where: { id: payment.userId },
                data: { accessGranted: true },
            });
            await ctx.reply(`To‘lov #${payment.id} tasdiqlandi.`);
            await this.notifyUser(payment.user.telegramId, 'To‘lovingiz tasdiqlandi.');
            await this.sendPrivateChannelAccessByUser(payment.user);
        });

        this.bot.callbackQuery(/^pay:reject:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const paymentId = Number(ctx.match[1]);
            const payment = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { user: true },
            });
            if (!payment || payment.status !== PaymentStatus.PENDING) {
                await ctx.reply('To‘lov holati mos emas.');
                return;
            }
            await this.prisma.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.REJECTED,
                    rejectionReason: 'To‘lov tasdiqlanmadi',
                    reviewedByAdminId: String(ctx.from?.id ?? ''),
                },
            });
            await ctx.reply(`To‘lov #${payment.id} rad etildi.`);
            await this.notifyUser(
                payment.user.telegramId,
                'To‘lov amalga oshirilmaganligi sababli chekingiz bekor qilindi. Qo‘llab-quvvatlash xizmatiga yozing.',
            );
        });

        this.bot.callbackQuery('admin:messages', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const users = await this.prisma.user.findMany({
                where: { messages: { some: { direction: MessageDirection.USER } } },
                include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
                orderBy: { updatedAt: 'desc' },
                take: 30,
            });
            if (!users.length) {
                await ctx.reply('User xabarlari topilmadi.');
                return;
            }
            const keyboard = new InlineKeyboard();
            for (const user of users) {
                keyboard.text(`@${user.username ?? user.telegramId}`, `msg:user:${user.id}`);
                keyboard.row();
            }
            await ctx.reply('Userlar ro‘yxati:', { reply_markup: keyboard });
        });

        this.bot.callbackQuery(/^msg:user:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const userId = Number(ctx.match[1]);
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) {
                await ctx.reply('User topilmadi.');
                return;
            }
            const historyDesc = await this.prisma.supportMessage.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 30,
            });
            if (!historyDesc.length) {
                await ctx.reply('Xabarlar topilmadi.');
                return;
            }
            const history = [...historyDesc].reverse();
            const body = history
                .map((item) => {
                    const sender = item.direction === MessageDirection.USER ? 'USER' : 'ADMIN';
                    const ts = item.createdAt.toLocaleString('uz-UZ');
                    return `${sender} (${ts}): ${item.text}`;
                })
                .join('\n\n');
            await ctx.reply(body, {
                reply_markup: new InlineKeyboard().text('Javob yozish', `msg:reply:${user.id}`),
            });
        });

        this.bot.callbackQuery(/^msg:reply:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const userId = Number(ctx.match[1]);
            const adminId = String(ctx.from?.id);
            this.adminReplyTargets.set(adminId, userId);
            await ctx.reply('Javob matnini yuboring.');
        });

        // Photo handler for receipts
        this.bot.on(':photo', async (ctx) => {
            if (!ctx.from || !ctx.message?.photo?.length) return;
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user || user.state !== UserState.AWAITING_RECEIPT) return;

            const paymentCard = await this.getSetting(SETTING_PAYMENT_CARD);
            const paymentAmountRaw = await this.getSetting(SETTING_PAYMENT_AMOUNT);
            const paymentAmount = Number(paymentAmountRaw ?? '0');
            if (!paymentCard || !Number.isFinite(paymentAmount) || paymentAmount <= 0) {
                await ctx.reply('To‘lov sozlamalari topilmadi, adminga yozing.');
                return;
            }

            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const payment = await this.prisma.payment.create({
                data: {
                    userId: user.id,
                    cardNumber: paymentCard,
                    amount: paymentAmount,
                    receiptFileId: photo.file_id,
                    receiptMessageId: String(ctx.message.message_id),
                    status: PaymentStatus.PENDING,
                },
                include: { user: true },
            });

            await this.prisma.user.update({ where: { id: user.id }, data: { state: UserState.IDLE } });
            await ctx.reply('Chek qabul qilindi. Admin tasdiqlashini kuting.');
            await this.forwardPaymentToArchive(payment.id, photo.file_id, user.telegramId);
            await this.notifyAdminsAboutPayment(payment.id, photo.file_id, user.telegramId);
        });

        // Text handler for support replies
        this.bot.on(':text', async (ctx) => {
            if (!ctx.from || !ctx.message?.text) return;
            if (ctx.message.text.startsWith('/')) return;

            const fromId = String(ctx.from.id);

            if (this.isAdmin(ctx.from.id) && this.adminReplyTargets.has(fromId)) {
                const targetUserId = this.adminReplyTargets.get(fromId);
                if (!targetUserId) return;

                const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
                if (!targetUser) {
                    await ctx.reply('User topilmadi.');
                    this.adminReplyTargets.delete(fromId);
                    return;
                }

                const messageText = ctx.message.text.trim();
                await this.prisma.supportMessage.create({
                    data: {
                        userId: targetUser.id,
                        direction: MessageDirection.ADMIN,
                        text: messageText,
                        adminTelegramId: fromId,
                    },
                });

                await this.notifyUser(targetUser.telegramId, `Admin javobi:\n${messageText}`);
                await ctx.reply('Javob yuborildi.');
                this.adminReplyTargets.delete(fromId);
                return;
            }

            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) return;

            if (user.state === UserState.AWAITING_SUPPORT_MESSAGE) {
                const text = ctx.message.text.trim();
                if (!text) {
                    await ctx.reply('Iltimos, matn yuboring.');
                    return;
                }
                await this.prisma.supportMessage.create({
                    data: {
                        userId: user.id,
                        direction: MessageDirection.USER,
                        text,
                    },
                });
                await this.prisma.user.update({ where: { id: user.id }, data: { state: UserState.IDLE } });
                await ctx.reply('Xabaringiz yuborildi.');
                await this.notifyAdminsAboutSupport(user, text);
            }
        });

        // Auto-approve join requests for eligible users
        this.bot.on('chat_join_request', async (ctx) => {
            const privateChannel = await this.prisma.channel.findFirst({
                where: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
            });
            if (!privateChannel) return;
            if (String(ctx.chatJoinRequest.chat.id) !== privateChannel.telegramId) return;

            const telegramId = String(ctx.chatJoinRequest.from.id);
            const user = await this.prisma.user.findUnique({ where: { telegramId } });
            if (!user) {
                await ctx.api.declineChatJoinRequest(Number(privateChannel.telegramId), Number(telegramId));
                return;
            }

            const eligible = await this.isEligible(user.id);
            if (eligible) {
                await ctx.api.approveChatJoinRequest(Number(privateChannel.telegramId), Number(telegramId));
                await this.notifyUser(telegramId, 'So‘rovingiz tasdiqlandi. Xush kelibsiz!');
            } else {
                await ctx.api.declineChatJoinRequest(Number(privateChannel.telegramId), Number(telegramId));
                await this.notifyUser(
                    telegramId,
                    'Sizda hali ruxsat yo‘q. 5 ta referral yoki tasdiqlangan to‘lov talab qilinadi.',
                );
            }
        });
    }

    private userMenuKeyboard(): Keyboard {
        return new Keyboard([
            ['Majburiy kanallar', 'To‘lov'],
            ['Referal', 'Qo‘llab-quvvatlash'],
        ]).resized();
    }

    private adminMenuKeyboard(): Keyboard {
        return new Keyboard([
            ['🧾 Payments', '💬 Support'],
            ['📊 Statistika', 'Asosiy menyu'],
        ]).resized();
    }

    private async sendReferralInfo(ctx: Context, user: User): Promise<void> {
        const goal = await this.getReferralGoal();
        const rawUsername = this.configService.get<string>('BOT_USERNAME')?.trim();
        const username = rawUsername?.replace(/^@/, '');
        const startParam = encodeURIComponent(user.referralCode);
        const link = username
            ? `https://t.me/${encodeURIComponent(username)}?start=${startParam}`
            : `Referral code: ${user.referralCode}`;
        await ctx.reply(`Sizning referral linkingiz:\n${link}\n\nProgress: ${user.invitedCount}/${goal}`);
    }

    private async getOrCreateUser(tgUser: Context['from'], payload?: string): Promise<User> {
        const telegramId = String(tgUser?.id);
        const existing = await this.prisma.user.findUnique({ where: { telegramId } });
        if (!existing) {
            const referralCode = await this.generateReferralCode();
            const invitedBy = payload
                ? await this.prisma.user.findUnique({ where: { referralCode: payload } })
                : null;
            return this.prisma.user.create({
                data: {
                    telegramId,
                    username: tgUser?.username,
                    firstName: tgUser?.first_name,
                    lastName: tgUser?.last_name,
                    referralCode,
                    referredById: invitedBy?.telegramId === telegramId ? null : invitedBy?.id,
                },
            });
        }
        if (!existing.referredById && payload) {
            const invitedBy = await this.prisma.user.findUnique({ where: { referralCode: payload } });
            if (invitedBy && invitedBy.telegramId !== telegramId) {
                await this.prisma.user.update({
                    where: { id: existing.id },
                    data: { referredById: invitedBy.id },
                });
            }
        }
        return this.prisma.user.update({
            where: { id: existing.id },
            data: {
                username: tgUser?.username,
                firstName: tgUser?.first_name,
                lastName: tgUser?.last_name,
            },
        });
    }

    private async handleCheck(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('/start ni qayta bosing.', { reply_markup: this.userMenuKeyboard() });
            return;
        }
        const checkResult = await this.checkRequiredChannels(user.telegramId);
        if (!checkResult.ok) {
            await ctx.reply(
                `Hali barcha kanallarga a’zo bo‘lmadingiz.\n${checkResult.missing.join('\n')}`,
                { reply_markup: this.userMenuKeyboard() },
            );
            return;
        }
        await this.creditInviterOnce(user.id);
        await this.ensureAccessIfEligible(user.id);
        const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
        if (!refreshed) return;
        if (await this.isEligible(refreshed.id)) {
            await this.sendPrivateChannelAccessByUser(refreshed);
            return;
        }
        const goal = await this.getReferralGoal();
        await ctx.reply(
            `Tasdiqlandi. Sizning taklif soningiz: ${refreshed.invitedCount}/${goal}.`,
            { reply_markup: this.userMenuKeyboard() },
        );
    }

    private async handlePay(ctx: Context): Promise<void> {
        const card = await this.getSetting(SETTING_PAYMENT_CARD);
        const amount = await this.getSetting(SETTING_PAYMENT_AMOUNT);
        if (!card || !amount) {
            await ctx.reply('To‘lov ma’lumotlari hali admin tomonidan kiritilmagan.', {
                reply_markup: this.userMenuKeyboard(),
            });
            return;
        }
        if (ctx.from) {
            const user = await this.findUserByTelegramId(ctx.from.id);
            if (user) {
                await this.prisma.user.update({
                    where: { id: user.id },
                    data: { state: UserState.AWAITING_RECEIPT },
                });
            }
        }
        await ctx.reply(
            `To‘lov qilish uchun:\nKarta: ${card}\nSumma: ${amount}\n\nChekni shu yerga yuboring.`,
            { reply_markup: this.userMenuKeyboard() },
        );
    }

    private async showAdminInfo(ctx: Context): Promise<void> {
        const [userCount, approvedPays, pendingPays] = await Promise.all([
            this.prisma.user.count(),
            this.prisma.payment.count({ where: { status: PaymentStatus.APPROVED } }),
            this.prisma.payment.count({ where: { status: PaymentStatus.PENDING } }),
        ]);
        await ctx.reply(
            `Userlar: ${userCount}\nTasdiqlangan to‘lovlar: ${approvedPays}\nKutilayotgan to‘lovlar: ${pendingPays}`,
            {
                reply_markup: new InlineKeyboard()
                    .text('Kutilmoqda', 'pay:list:PENDING')
                    .row()
                    .text('Tasdiqlangan', 'pay:list:APPROVED')
                    .row()
                    .text('Rad etilgan', 'pay:list:REJECTED'),
            },
        );
    }

    private async showPayments(
        ctx: Context,
        status: PaymentStatus,
        limitRaw?: string,
    ): Promise<void> {
        const limit = Number(limitRaw);
        const take = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 20;

        const payments = await this.prisma.payment.findMany({
            where: { status },
            include: { user: true },
            orderBy: { createdAt: 'desc' },
            take,
        });
        if (!payments.length) {
            await ctx.reply('Bu holatda to‘lovlar topilmadi.');
            return;
        }
        const lines = payments.map(
            (p) => `#${p.id} @${p.user.username ?? p.user.telegramId} | ${p.amount} | ${p.status}`,
        );
        await ctx.reply(
            `Ro‘yxat (${status}):\n${lines.join('\n')}\nTasdiqlash: /payapprove <id>\nRad etish: /payreject <id>`,
        );
    }

    private async showSupportList(ctx: Context, take = 30): Promise<void> {
        const users = await this.prisma.user.findMany({
            where: { messages: { some: { direction: MessageDirection.USER } } },
            orderBy: { updatedAt: 'desc' },
            take,
        });
        if (!users.length) {
            await ctx.reply('Support xabarlar topilmadi.');
            return;
        }
        const lines = users.map((u) => `id:${u.id} @${u.username ?? u.telegramId}`);
        await ctx.reply(
            `Support userlar:\n${lines.join('\n')}\nTarix: /msguser <id>\nJavob: /msgreply <id>`,
        );
    }

    private async findUserByTelegramId(telegramId: number | string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
    }

    private async getReferralGoal(): Promise<number> {
        const value = await this.getSetting(SETTING_REFERRAL_GOAL);
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
    }

    private async getSetting(key: string): Promise<string | null> {
        const setting = await this.prisma.setting.findUnique({ where: { key } });
        return setting?.value ?? null;
    }

    private async setSetting(key: string, value: string): Promise<void> {
        await this.prisma.setting.upsert({
            where: { key },
            update: { value },
            create: { key, value },
        });
    }

    private async generateReferralCode(): Promise<string> {
        while (true) {
            const code = Math.random().toString(36).slice(2, 10).toUpperCase();
            const exists = await this.prisma.user.findUnique({ where: { referralCode: code } });
            if (!exists) return code;
        }
    }

    private async checkRequiredChannels(telegramId: string): Promise<{ ok: boolean; missing: string[] }> {
        const requiredChannels = await this.prisma.channel.findMany({
            where: { type: ChannelType.REQUIRED, isActive: true },
        });
        if (!requiredChannels.length || !this.bot) {
            return { ok: true, missing: [] };
        }
        const missing: string[] = [];
        for (const channel of requiredChannels) {
            try {
                const member = (await this.bot.api.getChatMember(
                    Number(channel.telegramId),
                    Number(telegramId),
                )) as { status: string; is_member?: boolean };
                const joined =
                    member.status === 'creator' ||
                    member.status === 'administrator' ||
                    member.status === 'member' ||
                    (member.status === 'restricted' && Boolean(member.is_member));
                if (!joined) {
                    missing.push(channel.title ?? channel.telegramId);
                }
            } catch {
                missing.push(channel.title ?? channel.telegramId);
            }
        }
        return { ok: missing.length === 0, missing };
    }

    private async creditInviterOnce(userId: number): Promise<void> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user?.referredById || user.referralCreditedAt) return;

        const mark = await this.prisma.user.updateMany({
            where: { id: user.id, referralCreditedAt: null },
            data: { referralCreditedAt: new Date() },
        });
        if (mark.count === 0) return;

        const inviter = await this.prisma.user.update({
            where: { id: user.referredById },
            data: { invitedCount: { increment: 1 } },
        });
        await this.notifyUser(
            inviter.telegramId,
            `Tabriklaymiz, sizga 1 ta odam qo‘shildi. Jami: ${inviter.invitedCount}`,
        );
        const goal = await this.getReferralGoal();
        if (inviter.invitedCount >= goal) {
            await this.grantAccessAndNotify(inviter.id, 'Siz referral maqsadga yetdingiz!');
        }
    }

    private async isEligible(userId: number): Promise<boolean> {
        const goal = await this.getReferralGoal();
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) return false;
        if (user.accessGranted || user.invitedCount >= goal) return true;
        const approvedPayment = await this.prisma.payment.findFirst({
            where: { userId: user.id, status: PaymentStatus.APPROVED },
        });
        return Boolean(approvedPayment);
    }

    private async ensureAccessIfEligible(userId: number): Promise<void> {
        if (!(await this.isEligible(userId))) return;
        await this.prisma.user.update({ where: { id: userId }, data: { accessGranted: true } });
    }

    private async grantAccessAndNotify(userId: number, text: string): Promise<void> {
        const user = await this.prisma.user.update({
            where: { id: userId },
            data: { accessGranted: true },
        });
        await this.notifyUser(user.telegramId, text);
        await this.sendPrivateChannelAccessByUser(user);
    }

    private async sendPrivateChannelAccessByUser(user: User): Promise<void> {
        if (!this.bot) return;
        const privateChannel = await this.prisma.channel.findFirst({
            where: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
        });
        if (!privateChannel) {
            await this.notifyUser(
                user.telegramId,
                'Ruxsat berildi, lekin yopiq kanal admin tomonidan hali sozlanmagan.',
            );
            return;
        }
        const invite = await this.bot.api.createChatInviteLink(Number(privateChannel.telegramId), {
            creates_join_request: true,
            name: `access-${user.telegramId}-${Date.now()}`,
        });
        await this.notifyUser(
            user.telegramId,
            `Sizga ruxsat berildi. Kanalga kirish uchun havola:\n${invite.invite_link}\nSo‘rov yuboring, bot avtomatik tasdiqlaydi.`,
        );
    }

    private async notifyUser(telegramId: string, text: string): Promise<void> {
        if (!this.bot) return;
        try {
            await this.bot.api.sendMessage(Number(telegramId), text);
        } catch (error) {
            this.logger.warn(`Userga xabar yuborilmadi: ${telegramId} (${String(error)})`);
        }
    }

    private async forwardPaymentToArchive(
        paymentId: number,
        fileId: string,
        userTelegramId: string,
    ): Promise<void> {
        if (!this.bot) return;
        const archive = await this.prisma.channel.findFirst({
            where: { type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
        });
        if (!archive) return;
        try {
            await this.bot.api.sendPhoto(Number(archive.telegramId), fileId, {
                caption: `Payment #${paymentId} | user: ${userTelegramId}`,
            });
        } catch (error) {
            this.logger.warn(`Arxiv kanaliga yuborilmadi: ${String(error)}`);
        }
    }

    private async notifyAdminsAboutPayment(
        paymentId: number,
        fileId: string,
        userTelegramId: string,
    ): Promise<void> {
        if (!this.bot) return;
        const admins = this.getAdminIds();
        if (!admins.length) return;
        for (const adminId of admins) {
            try {
                await this.bot.api.sendPhoto(adminId, fileId, {
                    caption: `Yangi payment #${paymentId}\nUser: ${userTelegramId}\nTasdiqlash: /payapprove ${paymentId}\nRad etish: /payreject ${paymentId}`,
                });
            } catch (error) {
                this.logger.warn(`Adminga payment yuborilmadi: ${adminId} (${String(error)})`);
            }
        }
    }

    private async notifyAdminsAboutSupport(user: User, text: string): Promise<void> {
        if (!this.bot) return;
        const admins = this.getAdminIds();
        for (const adminId of admins) {
            try {
                await this.bot.api.sendMessage(
                    adminId,
                    `Support xabar\nUser: ${user.telegramId}\n@${user.username ?? 'username yo‘q'}\n\n${text}\nJavob berish: /msgreply ${user.id}`,
                );
            } catch (error) {
                this.logger.warn(`Support xabar adminga yuborilmadi: ${adminId}`);
            }
        }
    }

    private getAdminIds(): number[] {
        const raw = this.configService.get<string>('ADMIN_IDS') ?? '';
        return raw
            .split(',')
            .map((item) => Number(item.trim()))
            .filter((item) => Number.isFinite(item) && item > 0);
    }

    private isAdmin(telegramId: number): boolean {
        return this.getAdminIds().includes(telegramId);
    }

    private async ensureAdmin(ctx: Context): Promise<boolean> {
        if (!ctx.from || !this.isAdmin(ctx.from.id)) {
            if ('answerCallbackQuery' in ctx) {
                try {
                    await ctx.answerCallbackQuery({ text: 'Faqat adminlar uchun', show_alert: true });
                } catch {
                    // ignore
                }
            }
            await ctx.reply('Faqat adminlar uchun.');
            return false;
        }
        return true;
    }
}
