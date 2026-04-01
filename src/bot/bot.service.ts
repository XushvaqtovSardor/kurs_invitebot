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
const SETTING_PAYMENT_CARD_OWNER = 'payment_card_owner';
const SETTING_PAYMENT_AMOUNT = 'payment_amount';
const SETTING_PRIVATE_CHANNEL_LINK = 'private_channel_link';
const SETTING_REFERRAL_POSTER_FILE_ID = 'referral_poster_file_id';

type AdminPendingAction =
    | 'SET_PRIVATE_LINK'
    | 'SET_PRIVATE_CHANNEL_ID'
    | 'SET_DATABASE_CHANNEL'
    | 'SET_REFERRAL_POSTER'
    | 'SET_PAYMENT_CARD'
    | 'SET_PAYMENT_OWNER'
    | 'SET_PAYMENT_AMOUNT'
    | 'ADD_REQUIRED_TELEGRAM_CHAT'
    | 'ADD_REQUIRED_TELEGRAM_LINK'
    | 'ADD_REQUIRED_EXTERNAL_URL'
    | 'ADD_REQUIRED_EXTERNAL_TITLE';
type RequiredChannelInfo = {
    id: number;
    telegramId: string;
    title: string | null;
    username: string | null;
    isExternal: boolean;
};

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BotService.name);
    private readonly adminReplyTargets = new Map<string, number>();
    private readonly adminPendingActions = new Map<string, AdminPendingAction>();
    private readonly adminPaymentDrafts = new Map<string, { card: string; owner: string }>();
    private readonly adminRequiredDrafts = new Map<string, { chatId?: string; url?: string }>();
    private readonly requiredGateConfirmedUsers = new Set<number>();
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

        // User command
        this.bot.command('start', async (ctx) => this.handleStart(ctx));
        this.bot.command('admin', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showAdminPanel(ctx);
        });

        // Reply keyboards for users/admins
        this.bot.hears('✅ A’zo bo‘ldim', async (ctx) => this.handleCheck(ctx));
        this.bot.hears("✅ A'zo bo'ldim", async (ctx) => this.handleCheck(ctx));
        this.bot.hears('Majburiy kanallar', async (ctx) => this.handleCheck(ctx));
        this.bot.hears('📊 Mening statistikam', async (ctx) => this.showUserStatsByContext(ctx));
        this.bot.hears('🔗 Referral link', async (ctx) => this.handleReferralRequest(ctx));
        this.bot.hears('Referal', async (ctx) => this.handleReferralRequest(ctx));
        this.bot.hears('👥 Mening takliflarim', async (ctx) => this.handleInvitesRequest(ctx));
        this.bot.hears('🔒 Yopiq kanal linki', async (ctx) => this.handlePrivateLinkRequest(ctx));
        this.bot.hears('💳 To‘lov qilish', async (ctx) => this.handlePay(ctx));
        this.bot.hears('To‘lov', async (ctx) => this.handlePay(ctx));
        this.bot.hears('💬 Qo‘llab-quvvatlash', async (ctx) => this.startSupportFlow(ctx));
        this.bot.hears('Qo‘llab-quvvatlash', async (ctx) => this.startSupportFlow(ctx));
        this.bot.hears('Bekor qilish', async (ctx) => this.handleCancel(ctx));

        this.bot.hears('Asosiy menyu', async (ctx) => {
            if (ctx.from && this.isAdmin(ctx.from.id)) {
                await this.showAdminPanel(ctx);
                return;
            }
            await this.showUserDashboardOrGate(ctx);
        });

        // Admin reply-keyboard shortcuts
        this.bot.hears('📊 Statistika', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showAdminInfo(ctx);
        });
        this.bot.hears('👥 Foydalanuvchilar', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showTopUsers(ctx);
        });
        this.bot.hears('🧾 To‘lovlar', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showPaymentSections(ctx);
        });
        this.bot.hears('🧾 Payments', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showPaymentSections(ctx);
        });
        this.bot.hears('💬 Xabarlar', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showSupportList(ctx);
        });
        this.bot.hears('💬 Support', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showSupportList(ctx);
        });
        this.bot.hears('🔐 Linkni o‘rnatish', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showPrivateLinkManager(ctx);
        });
        this.bot.hears('🗂 Database kanal', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showDatabaseChannelManager(ctx);
        });
        this.bot.hears('💳 To‘lov sozlash', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showPaymentManager(ctx);
        });
        this.bot.hears('🖼 Referral posteri', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showReferralPosterManager(ctx);
        });
        this.bot.hears('📌 Majburiy kanallar', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await this.showRequiredChannelsManager(ctx);
        });

        // Inline keyboards
        this.bot.callbackQuery('gate:check', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handleCheck(ctx);
        });

        this.bot.callbackQuery('main:check', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handleCheck(ctx);
        });

        this.bot.callbackQuery('main:stats', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.showUserStatsByContext(ctx);
        });

        this.bot.callbackQuery('main:ref', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handleReferralRequest(ctx);
        });

        this.bot.callbackQuery('main:invites', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handleInvitesRequest(ctx);
        });

        this.bot.callbackQuery('main:private', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handlePrivateLinkRequest(ctx);
        });

        this.bot.callbackQuery('main:pay', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handlePay(ctx);
        });

        this.bot.callbackQuery('main:support', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.startSupportFlow(ctx);
        });

        this.bot.callbackQuery('pay:send_receipt', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.beginReceiptFlow(ctx);
        });

        this.bot.callbackQuery('pay:cancel', async (ctx) => {
            await ctx.answerCallbackQuery();
            await this.handleCancel(ctx);
        });

        // Admin callback flows for payments/messages
        this.bot.callbackQuery('admin:payments', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showPaymentSections(ctx);
        });

        this.bot.callbackQuery('admin:messages', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showSupportList(ctx);
        });

        this.bot.callbackQuery('admin:set_private_link', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptSetPrivateLink(ctx);
        });

        this.bot.callbackQuery('admin:set_private_channel', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptSetPrivateChannelId(ctx);
        });

        this.bot.callbackQuery('admin:manage_private', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showPrivateLinkManager(ctx);
        });

        this.bot.callbackQuery('admin:delete_private_link', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.deleteSetting(SETTING_PRIVATE_CHANNEL_LINK);
            this.clearAdminSession(String(ctx.from?.id ?? ''));
            await ctx.reply('Yopiq kanal linki o‘chirildi.');
            await this.showPrivateLinkManager(ctx);
        });

        this.bot.callbackQuery('admin:delete_private_channel', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.prisma.channel.updateMany({
                where: { type: ChannelType.PRIVATE_ACCESS },
                data: { isActive: false },
            });
            this.clearAdminSession(String(ctx.from?.id ?? ''));
            await ctx.reply('Private kanal ID o‘chirildi.');
            await this.showPrivateLinkManager(ctx);
        });

        this.bot.callbackQuery('admin:set_archive', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptSetDatabaseChannel(ctx);
        });

        this.bot.callbackQuery('admin:manage_archive', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showDatabaseChannelManager(ctx);
        });

        this.bot.callbackQuery('admin:delete_archive', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.prisma.channel.updateMany({
                where: { type: ChannelType.RECEIPT_ARCHIVE },
                data: { isActive: false },
            });
            this.clearAdminSession(String(ctx.from?.id ?? ''));
            await ctx.reply('Database kanal o‘chirildi.');
            await this.showDatabaseChannelManager(ctx);
        });

        this.bot.callbackQuery('admin:set_payment', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptSetPaymentDetails(ctx);
        });

        this.bot.callbackQuery('admin:manage_payment', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showPaymentManager(ctx);
        });

        this.bot.callbackQuery('admin:delete_payment', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.clearPaymentSettings();
            this.clearAdminSession(String(ctx.from?.id ?? ''));
            await ctx.reply('To‘lov rekvizitlari o‘chirildi.');
            await this.showPaymentManager(ctx);
        });

        this.bot.callbackQuery('admin:set_ref_poster', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptSetReferralPoster(ctx);
        });

        this.bot.callbackQuery('admin:manage_ref_poster', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showReferralPosterManager(ctx);
        });

        this.bot.callbackQuery('admin:delete_ref_poster', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.deleteSetting(SETTING_REFERRAL_POSTER_FILE_ID);
            this.clearAdminSession(String(ctx.from?.id ?? ''));
            await ctx.reply('Referral posteri o‘chirildi.');
            await this.showReferralPosterManager(ctx);
        });

        this.bot.callbackQuery('admin:manage_required', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showRequiredChannelsManager(ctx);
        });

        this.bot.callbackQuery('admin:req:add_tg', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptAddRequiredTelegram(ctx);
        });

        this.bot.callbackQuery('admin:req:add_ext', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.promptAddRequiredExternal(ctx);
        });

        this.bot.callbackQuery('admin:req:remove_menu', async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            await this.showRequiredChannelsDeleteMenu(ctx);
        });

        this.bot.callbackQuery(/^admin:req:del:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const channelId = Number(ctx.match[1]);
            if (!Number.isInteger(channelId)) {
                await ctx.reply('Kanal topilmadi.');
                return;
            }

            await this.prisma.channel.updateMany({
                where: { id: channelId, type: ChannelType.REQUIRED },
                data: { isActive: false },
            });
            await ctx.reply('Majburiy havola o‘chirildi.');
            await this.showRequiredChannelsDeleteMenu(ctx);
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
                payment.rejectionReason ? `Sabab: ${payment.rejectionReason}` : undefined,
            ]
                .filter(Boolean)
                .join('\n');

            if (payment.status === PaymentStatus.PENDING) {
                await ctx.reply(text, {
                    reply_markup: new InlineKeyboard()
                        .text('✅ Tasdiqlash', `pay:approve:${payment.id}`)
                        .row()
                        .text('❌ Rad etish', `pay:reject:${payment.id}`),
                });
                return;
            }

            await ctx.reply(text);
        });

        this.bot.callbackQuery(/^pay:approve:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const paymentId = Number(ctx.match[1]);

            const result = await this.approvePaymentById(paymentId, String(ctx.from?.id ?? ''));
            await ctx.reply(result.message);
            if (!result.ok || !result.user) return;

            await this.notifyUser(
                result.user.telegramId,
                'To‘lovingiz tasdiqlandi. Endi yopiq kanalga kirishingiz mumkin.',
            );
            await this.sendPrivateChannelAccessByUser(result.user);
        });

        this.bot.callbackQuery(/^pay:reject:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const paymentId = Number(ctx.match[1]);

            const result = await this.rejectPaymentById(
                paymentId,
                String(ctx.from?.id ?? ''),
                'To‘lov tasdiqlanmadi',
            );
            await ctx.reply(result.message);
            if (!result.ok || !result.user) return;

            await this.notifyUser(
                result.user.telegramId,
                'Chekingiz rad etildi. Iltimos, to‘g‘ri chek yuboring yoki supportga yozing.',
            );
        });

        this.bot.callbackQuery(/^msg:user:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();
            const userId = Number(ctx.match[1]);
            await this.showSupportHistory(ctx, userId);
        });

        this.bot.callbackQuery(/^msg:reply:(\d+)$/, async (ctx) => {
            if (!(await this.ensureAdmin(ctx))) return;
            await ctx.answerCallbackQuery();

            const userId = Number(ctx.match[1]);
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) {
                await ctx.reply('User topilmadi.');
                return;
            }

            const adminId = String(ctx.from?.id);
            this.adminReplyTargets.set(adminId, userId);
            await ctx.reply('Javob matnini yuboring.');
        });

        // Photo handler for receipts
        this.bot.on(':photo', async (ctx) => {
            if (!ctx.from || !ctx.message?.photo?.length) return;

            const adminId = String(ctx.from.id);
            if (this.isAdmin(ctx.from.id) && this.adminPendingActions.get(adminId) === 'SET_REFERRAL_POSTER') {
                const poster = ctx.message.photo[ctx.message.photo.length - 1];
                await this.setSetting(SETTING_REFERRAL_POSTER_FILE_ID, poster.file_id);
                this.adminPendingActions.delete(adminId);

                await ctx.reply('Referral posteri saqlandi.', {
                    reply_markup: this.adminMenuKeyboard(),
                });
                await this.forwardPosterToArchive(poster.file_id, adminId);
                return;
            }

            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user || user.state !== UserState.AWAITING_RECEIPT) return;

            const subscription = await this.checkRequiredChannels(user.telegramId);
            if (!subscription.ok) {
                await this.sendRequiredSubscriptionPrompt(
                    ctx,
                    subscription.joinChannels,
                    subscription.missingTelegram.length,
                );
                return;
            }

            const paymentCard = await this.getSetting(SETTING_PAYMENT_CARD);
            const paymentOwner = await this.getSetting(SETTING_PAYMENT_CARD_OWNER);
            const paymentAmountRaw = await this.getSetting(SETTING_PAYMENT_AMOUNT);
            const paymentAmount = Number(paymentAmountRaw ?? '0');
            if (!paymentCard || !paymentOwner || !Number.isFinite(paymentAmount) || paymentAmount <= 0) {
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

            await this.prisma.user.update({
                where: { id: user.id },
                data: { state: UserState.IDLE },
            });

            await ctx.reply(
                'Chek qabul qilindi. Admin tekshiradi. Natija bo‘yicha sizga xabar beriladi.',
                { reply_markup: this.userMenuKeyboard() },
            );
            await this.forwardPaymentToArchive(payment.id, photo.file_id, user.telegramId);
            await this.notifyAdminsAboutPayment(payment.id, photo.file_id, user.telegramId);
        });

        // Text handler for support replies and admin setup states
        this.bot.on(':text', async (ctx) => {
            if (!ctx.from || !ctx.message?.text) return;
            if (ctx.message.text.startsWith('/')) return;

            const fromId = String(ctx.from.id);
            const text = ctx.message.text.trim();

            if (this.isAdmin(ctx.from.id) && this.adminReplyTargets.has(fromId)) {
                const targetUserId = this.adminReplyTargets.get(fromId);
                if (!targetUserId) return;

                const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
                if (!targetUser) {
                    await ctx.reply('User topilmadi.');
                    this.adminReplyTargets.delete(fromId);
                    return;
                }

                await this.prisma.supportMessage.create({
                    data: {
                        userId: targetUser.id,
                        direction: MessageDirection.ADMIN,
                        text,
                        adminTelegramId: fromId,
                    },
                });

                await this.notifyUser(targetUser.telegramId, `Admin javobi:\n${text}`);
                await ctx.reply('Javob yuborildi.');
                this.adminReplyTargets.delete(fromId);
                return;
            }

            if (this.isAdmin(ctx.from.id) && this.adminPendingActions.has(fromId)) {
                const handled = await this.handleAdminPendingText(ctx, text, fromId);
                if (handled) {
                    return;
                }
            }

            const user = await this.findUserByTelegramId(ctx.from.id);
            if (!user) return;

            if (user.state === UserState.AWAITING_SUPPORT_MESSAGE) {
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
                await this.prisma.user.update({
                    where: { id: user.id },
                    data: { state: UserState.IDLE },
                });

                await ctx.reply('Xabaringiz supportga yuborildi.', {
                    reply_markup: this.userMenuKeyboard(),
                });
                await this.notifyAdminsAboutSupport(user, text);
            }
        });

        // Auto-approve join requests only for users who received a private link from the bot
        this.bot.on('chat_join_request', async (ctx) => {
            const privateChannel = await this.prisma.channel.findFirst({
                where: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
            });
            if (!privateChannel) return;
            if (String(ctx.chatJoinRequest.chat.id) !== privateChannel.telegramId) return;

            const telegramId = String(ctx.chatJoinRequest.from.id);
            const user = await this.prisma.user.findUnique({ where: { telegramId } });

            if (!user) {
                // Unknown users stay pending so admins can review manually.
                return;
            }

            const grant = await this.prisma.privateAccessGrant.findFirst({
                where: {
                    userId: user.id,
                    channelTelegramId: privateChannel.telegramId,
                    isActive: true,
                    approvedAt: null,
                },
                orderBy: { createdAt: 'desc' },
            });
            if (!grant) {
                // Bot sent no private link to this user, keep request pending for manual admin decision.
                return;
            }

            await ctx.api.approveChatJoinRequest(Number(privateChannel.telegramId), Number(telegramId));
            await this.prisma.privateAccessGrant.update({
                where: { id: grant.id },
                data: {
                    approvedAt: new Date(),
                    isActive: false,
                },
            });
            await this.notifyUser(telegramId, 'So‘rovingiz tasdiqlandi. Xush kelibsiz!');
        });
    }

    private async handleStart(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const payload = ctx.message?.text?.split(' ')[1]?.trim();
        const user = await this.getOrCreateUser(ctx.from, payload);
        await this.ensureAccessIfEligible(user.id);

        // Every /start should re-open required links gate when external links exist.
        this.requiredGateConfirmedUsers.delete(user.id);
        const required = await this.checkRequiredChannels(user.telegramId);
        const needsExternalConfirmation =
            required.externalLinks.length > 0 && !this.requiredGateConfirmedUsers.has(user.id);
        if (!required.ok || needsExternalConfirmation) {
            await this.sendRequiredSubscriptionPrompt(
                ctx,
                required.joinChannels,
                required.missingTelegram.length,
            );
            return;
        }

        await this.creditInviterOnce(user.id);
        await this.ensureAccessIfEligible(user.id);
        await this.sendUserDashboard(ctx, user.id, true);

        if (!this.isAdmin(ctx.from.id)) {
            const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
            if (refreshed) {
                await this.sendReferralInfo(ctx, refreshed);
            }
        }
    }

    private async showUserDashboardOrGate(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        await this.sendUserDashboard(ctx, user.id, false);
    }

    private async showUserStatsByContext(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        await this.sendUserDashboard(ctx, user.id, false);

        if (!this.isAdmin(ctx.from.id)) {
            const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
            if (refreshed) {
                await this.sendReferralInfo(ctx, refreshed);
            }
        }
    }

    private async handleReferralRequest(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        await this.sendReferralInfo(ctx, user);
    }

    private async handleInvitesRequest(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        const referrals = await this.prisma.user.findMany({
            where: { referredById: user.id },
            orderBy: { createdAt: 'desc' },
            take: 30,
        });

        if (!referrals.length) {
            await ctx.reply('Hozircha siz orqali ro‘yxatdan o‘tgan foydalanuvchilar yo‘q.', {
                reply_markup: this.userMenuKeyboard(),
            });
            return;
        }

        const lines = referrals.map((ref, index) => {
            const name = ref.username ? `@${ref.username}` : ref.firstName ?? ref.telegramId;
            const status = ref.referralCreditedAt
                ? 'hisoblandi ✅'
                : 'hali a’zo bo‘lmagan (kutilmoqda) ⏳';
            return `${index + 1}. ${name} - ${status}`;
        });

        await ctx.reply(`Siz taklif qilgan foydalanuvchilar:\n\n${lines.join('\n')}`, {
            reply_markup: this.userMenuKeyboard(),
        });
    }

    private async handlePrivateLinkRequest(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        await this.ensureAccessIfEligible(user.id);
        const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
        if (!refreshed) return;

        if (await this.isEligible(refreshed.id)) {
            await this.sendPrivateChannelAccessByUser(refreshed);
            return;
        }

        const goal = await this.getReferralGoal();
        const missing = Math.max(goal - refreshed.invitedCount, 0);
        await ctx.reply(
            [
                'Siz hali yopiq kanalga kirish huquqiga ega emassiz.',
                `Taklif qilganlar: ${refreshed.invitedCount}/${goal}`,
                `Yetishmayotgan takliflar: ${missing}`,
                '',
                `Yopiq kanalga kirish uchun: ${goal} ta taklif qiling yoki to‘lov qiling.`,
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('🔗 Referral link', 'main:ref')
                    .row()
                    .text('💳 To‘lov qilish', 'main:pay')
                    .row()
                    .text('📊 Mening statistikam', 'main:stats'),
            },
        );
    }

    private async startSupportFlow(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { state: UserState.AWAITING_SUPPORT_MESSAGE },
        });
        await ctx.reply('Muammoingizni bitta xabarda yuboring.', {
            reply_markup: this.cancelKeyboard(),
        });
    }

    private async handleCancel(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const actorId = String(ctx.from.id);

        this.adminReplyTargets.delete(actorId);
        this.clearAdminSession(actorId);

        const user = await this.findUserByTelegramId(actorId);
        if (user && user.state !== UserState.IDLE) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { state: UserState.IDLE },
            });
        }

        if (ctx.from && this.isAdmin(ctx.from.id)) {
            await ctx.reply('Bekor qilindi.', { reply_markup: this.adminMenuKeyboard() });
            return;
        }

        await ctx.reply('Bekor qilindi.', { reply_markup: this.userMenuKeyboard() });
    }

    private async beginReceiptFlow(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib /start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { state: UserState.AWAITING_RECEIPT },
        });

        await ctx.reply('Chek rasmini yuboring (photo).', {
            reply_markup: new InlineKeyboard().text('Bekor qilish', 'pay:cancel'),
        });
    }

    private async showAdminPanel(ctx: Context): Promise<void> {
        await ctx.reply('Admin paneliga xush kelibsiz. Bo‘limlardan birini tanlang:', {
            reply_markup: this.adminMenuKeyboard(),
        });
    }

    private clearAdminSession(adminId: string): void {
        if (!adminId) return;
        this.adminPendingActions.delete(adminId);
        this.adminPaymentDrafts.delete(adminId);
        this.adminRequiredDrafts.delete(adminId);
    }

    private async showPrivateLinkManager(ctx: Context): Promise<void> {
        const privateLink = await this.getSetting(SETTING_PRIVATE_CHANNEL_LINK);
        const privateChannel = await this.prisma.channel.findFirst({
            where: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
        });

        await ctx.reply(
            [
                'Yopiq kanal linki boshqaruvi:',
                `Joriy link: ${privateLink ?? 'o‘rnatilmagan'}`,
                `Private kanal ID: ${privateChannel?.telegramId ?? 'o‘rnatilmagan'}`,
                '',
                'Qaysi amalni bajarasiz?',
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('🔐 Kanal ID ni yangilash', 'admin:set_private_channel')
                    .row()
                    .text('🗑 Kanal ID ni o‘chirish', 'admin:delete_private_channel')
                    .row()
                    .text('✏️ Linkni yangilash', 'admin:set_private_link')
                    .row()
                    .text('🗑 Linkni o‘chirish', 'admin:delete_private_link'),
            },
        );
    }

    private async showDatabaseChannelManager(ctx: Context): Promise<void> {
        const archiveChannel = await this.prisma.channel.findFirst({
            where: { type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
        });

        await ctx.reply(
            [
                'Database kanal boshqaruvi:',
                `Joriy kanal ID: ${archiveChannel?.telegramId ?? 'o‘rnatilmagan'}`,
                '',
                'Qaysi amalni bajarasiz?',
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('✏️ Kanalni yangilash', 'admin:set_archive')
                    .row()
                    .text('🗑 Kanalni o‘chirish', 'admin:delete_archive'),
            },
        );
    }

    private async showPaymentManager(ctx: Context): Promise<void> {
        const card = await this.getSetting(SETTING_PAYMENT_CARD);
        const owner = await this.getSetting(SETTING_PAYMENT_CARD_OWNER);
        const amount = await this.getSetting(SETTING_PAYMENT_AMOUNT);

        await ctx.reply(
            [
                'To‘lov rekvizitlari boshqaruvi:',
                `Karta: ${card ?? 'o‘rnatilmagan'}`,
                `Karta egasi: ${owner ?? 'o‘rnatilmagan'}`,
                `Summa: ${amount ?? 'o‘rnatilmagan'}`,
                '',
                'Qaysi amalni bajarasiz?',
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('✏️ Rekvizitlarni yangilash', 'admin:set_payment')
                    .row()
                    .text('🗑 Rekvizitlarni o‘chirish', 'admin:delete_payment'),
            },
        );
    }

    private async showReferralPosterManager(ctx: Context): Promise<void> {
        const posterFileId = await this.getSetting(SETTING_REFERRAL_POSTER_FILE_ID);

        await ctx.reply(
            [
                'Referral posteri boshqaruvi:',
                `Holat: ${posterFileId ? 'o‘rnatilgan' : 'o‘rnatilmagan'}`,
                '',
                'Qaysi amalni bajarasiz?',
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('✏️ Poster yuklash', 'admin:set_ref_poster')
                    .row()
                    .text('🗑 Posterni o‘chirish', 'admin:delete_ref_poster'),
            },
        );
    }

    private async showRequiredChannelsManager(ctx: Context): Promise<void> {
        const channels = await this.prisma.channel.findMany({
            where: { type: ChannelType.REQUIRED, isActive: true },
            orderBy: { createdAt: 'asc' },
        });

        const telegramCount = channels.filter((item) => !this.isExternalRequiredChannel(item)).length;
        const externalCount = channels.length - telegramCount;
        const lines = channels.length
            ? channels.map((channel, index) => {
                const kind = this.isExternalRequiredChannel(channel) ? 'External' : 'Telegram';
                const label = this.getRequiredChannelDisplayName(channel);
                return `${index + 1}. [${kind}] ${label}`;
            })
            : ['Hozircha majburiy havolalar yo‘q.'];

        await ctx.reply(
            [
                'Majburiy kanallar boshqaruvi:',
                `Telegram: ${telegramCount} ta`,
                `External: ${externalCount} ta`,
                '',
                lines.join('\n'),
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('➕ Telegram kanal qo‘shish', 'admin:req:add_tg')
                    .row()
                    .text('➕ External havola qo‘shish', 'admin:req:add_ext')
                    .row()
                    .text('🗑 O‘chirish', 'admin:req:remove_menu')
                    .row()
                    .text('🔄 Yangilash', 'admin:manage_required'),
            },
        );
    }

    private async showRequiredChannelsDeleteMenu(ctx: Context): Promise<void> {
        const channels = await this.prisma.channel.findMany({
            where: { type: ChannelType.REQUIRED, isActive: true },
            orderBy: { createdAt: 'asc' },
            take: 40,
        });

        if (!channels.length) {
            await ctx.reply('O‘chirish uchun majburiy havola topilmadi.', {
                reply_markup: new InlineKeyboard().text('⬅️ Orqaga', 'admin:manage_required'),
            });
            return;
        }

        const keyboard = new InlineKeyboard();
        channels.forEach((channel, index) => {
            const kind = this.isExternalRequiredChannel(channel) ? 'External' : 'Telegram';
            keyboard.text(`🗑 ${index + 1}. ${kind}`, `admin:req:del:${channel.id}`);
            keyboard.row();
        });
        keyboard.text('⬅️ Orqaga', 'admin:manage_required');

        const lines = channels.map((channel, index) => {
            const kind = this.isExternalRequiredChannel(channel) ? 'External' : 'Telegram';
            const name = this.getRequiredChannelDisplayName(channel);
            return `${index + 1}. [${kind}] ${name}`;
        });

        await ctx.reply(
            [
                'O‘chirish uchun havolani tanlang:',
                '',
                lines.join('\n'),
            ].join('\n'),
            { reply_markup: keyboard },
        );
    }

    private async promptAddRequiredTelegram(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const adminId = String(ctx.from.id);
        this.clearAdminSession(adminId);
        this.adminPendingActions.set(adminId, 'ADD_REQUIRED_TELEGRAM_CHAT');
        await ctx.reply('Telegram kanal chat ID ni yuboring. Masalan: -1001234567890\nKanal ID ni @userinfobot yordamida olishingiz mumkin.\nBot o‘sha kanalda admin bo‘lishi shart.', {
            reply_markup: this.cancelKeyboard(),
        });
    }

    private async promptAddRequiredExternal(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const adminId = String(ctx.from.id);
        this.clearAdminSession(adminId);
        this.adminPendingActions.set(adminId, 'ADD_REQUIRED_EXTERNAL_URL');
        await ctx.reply('External havolani yuboring. Masalan: https://instagram.com/yourpage', {
            reply_markup: this.cancelKeyboard(),
        });
    }

    private async promptSetPrivateLink(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        this.clearAdminSession(String(ctx.from.id));
        this.adminPendingActions.set(String(ctx.from.id), 'SET_PRIVATE_LINK');
        await ctx.reply(
            'Yopiq kanal linkini yuboring.\nNamuna: https://t.me/+XXXXXX\nAuto-approve ishlashi uchun private kanal ID ham o‘rnatilgan bo‘lishi kerak.',
            { reply_markup: this.cancelKeyboard() },
        );
    }

    private async promptSetPrivateChannelId(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        this.clearAdminSession(String(ctx.from.id));
        this.adminPendingActions.set(String(ctx.from.id), 'SET_PRIVATE_CHANNEL_ID');
        await ctx.reply(
            'Private kanal ID ni yuboring.\nNamuna: -1001234567890\nKanal ID ni @userinfobot yordamida olishingiz mumkin.\nBot shu kanalda admin bo‘lishi shart.',
            { reply_markup: this.cancelKeyboard() },
        );
    }

    private async promptSetDatabaseChannel(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        this.clearAdminSession(String(ctx.from.id));
        this.adminPendingActions.set(String(ctx.from.id), 'SET_DATABASE_CHANNEL');
        await ctx.reply(
            'Database kanal ID ni yuboring.\nNamuna: -1001234567890',
            { reply_markup: this.cancelKeyboard() },
        );
    }

    private async promptSetPaymentDetails(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const adminId = String(ctx.from.id);
        this.clearAdminSession(adminId);
        this.adminPendingActions.set(adminId, 'SET_PAYMENT_CARD');
        await ctx.reply('To‘lov uchun karta raqamini kiriting.', {
            reply_markup: this.cancelKeyboard(),
        });
    }

    private async promptSetReferralPoster(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        this.clearAdminSession(String(ctx.from.id));
        this.adminPendingActions.set(String(ctx.from.id), 'SET_REFERRAL_POSTER');
        await ctx.reply('Referral uchun posterni rasm ko‘rinishida yuboring (photo).', {
            reply_markup: this.cancelKeyboard(),
        });
    }

    private async handleAdminPendingText(
        ctx: Context,
        text: string,
        adminId: string,
    ): Promise<boolean> {
        const action = this.adminPendingActions.get(adminId);
        if (!action) {
            return false;
        }

        if (text.toLowerCase() === 'bekor qilish') {
            this.clearAdminSession(adminId);
            await ctx.reply('Amal bekor qilindi.', { reply_markup: this.adminMenuKeyboard() });
            return true;
        }

        if (action === 'ADD_REQUIRED_TELEGRAM_CHAT') {
            if (!/^-?\d+$/.test(text)) {
                await ctx.reply('Chat ID noto‘g‘ri. Namuna: -1001234567890');
                return true;
            }

            this.adminRequiredDrafts.set(adminId, { chatId: text });
            this.adminPendingActions.set(adminId, 'ADD_REQUIRED_TELEGRAM_LINK');
            await ctx.reply(
                'Endi kanal linkini yuboring (@username yoki https://t.me/...).\nAgar link bo‘lmasa, - deb yuboring.',
                { reply_markup: this.cancelKeyboard() },
            );
            return true;
        }

        if (action === 'ADD_REQUIRED_TELEGRAM_LINK') {
            const draft = this.adminRequiredDrafts.get(adminId);
            const chatId = draft?.chatId;
            if (!chatId) {
                this.adminPendingActions.set(adminId, 'ADD_REQUIRED_TELEGRAM_CHAT');
                await ctx.reply('Session topilmadi. Qaytadan chat ID kiriting.', {
                    reply_markup: this.cancelKeyboard(),
                });
                return true;
            }

            const normalizedInput = text.trim();
            let link: string | null = null;
            if (!/^(-|yo['’]?q)$/i.test(normalizedInput)) {
                link = this.normalizeTelegramLink(normalizedInput);
                if (!link) {
                    await ctx.reply('Link noto‘g‘ri. Namuna: @channel yoki https://t.me/channel');
                    return true;
                }
            }

            try {
                await this.upsertRequiredTelegramChannel(chatId, link);
                this.clearAdminSession(adminId);
                await ctx.reply('Telegram majburiy kanal saqlandi.', {
                    reply_markup: this.adminMenuKeyboard(),
                });
                await this.showRequiredChannelsManager(ctx);
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : 'Telegram majburiy kanalni saqlab bo‘lmadi.';
                await ctx.reply(message);
            }
            return true;
        }

        if (action === 'ADD_REQUIRED_EXTERNAL_URL') {
            const url = this.normalizeExternalLink(text);
            if (!url) {
                await ctx.reply('External link noto‘g‘ri. Masalan: https://instagram.com/yourpage');
                return true;
            }

            this.adminRequiredDrafts.set(adminId, { url });
            this.adminPendingActions.set(adminId, 'ADD_REQUIRED_EXTERNAL_TITLE');
            await ctx.reply('Havola nomini kiriting (masalan: Instagram). Nom kiritmasangiz - yuboring.', {
                reply_markup: this.cancelKeyboard(),
            });
            return true;
        }

        if (action === 'ADD_REQUIRED_EXTERNAL_TITLE') {
            const draft = this.adminRequiredDrafts.get(adminId);
            const url = draft?.url;
            if (!url) {
                this.adminPendingActions.set(adminId, 'ADD_REQUIRED_EXTERNAL_URL');
                await ctx.reply('Session topilmadi. Qaytadan external link yuboring.', {
                    reply_markup: this.cancelKeyboard(),
                });
                return true;
            }

            const title = /^(-|yo['’]?q)$/i.test(text.trim()) ? null : text.trim();
            await this.createRequiredExternalLink(url, title);
            this.clearAdminSession(adminId);
            await ctx.reply('External majburiy havola saqlandi.', {
                reply_markup: this.adminMenuKeyboard(),
            });
            await this.showRequiredChannelsManager(ctx);
            return true;
        }

        if (action === 'SET_PRIVATE_LINK') {
            const normalized = this.normalizeTelegramLink(text);
            if (!normalized) {
                await ctx.reply('Link noto‘g‘ri. Namuna: https://t.me/+XXXXXX');
                return true;
            }

            await this.setSetting(SETTING_PRIVATE_CHANNEL_LINK, normalized);
            this.clearAdminSession(adminId);
            await ctx.reply('Yopiq kanal linki saqlandi.', {
                reply_markup: this.adminMenuKeyboard(),
            });
            return true;
        }

        if (action === 'SET_PRIVATE_CHANNEL_ID') {
            if (!/^-?\d+$/.test(text)) {
                await ctx.reply('Kanal ID noto‘g‘ri. Namuna: -1001234567890');
                return true;
            }

            try {
                await this.ensureBotAdminInChannelOrThrow(text);

                await this.prisma.channel.updateMany({
                    where: { type: ChannelType.PRIVATE_ACCESS },
                    data: { isActive: false },
                });
                await this.prisma.channel.upsert({
                    where: { telegramId: text },
                    update: { type: ChannelType.PRIVATE_ACCESS, isActive: true },
                    create: { telegramId: text, type: ChannelType.PRIVATE_ACCESS, isActive: true },
                });

                this.clearAdminSession(adminId);
                await ctx.reply(
                    'Private kanal ID saqlandi. Bot adminligi tasdiqlandi.',
                    { reply_markup: this.adminMenuKeyboard() },
                );
                await this.showPrivateLinkManager(ctx);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : 'Private kanalni saqlab bo‘lmadi.';
                await ctx.reply(message);
            }
            return true;
        }

        if (action === 'SET_DATABASE_CHANNEL') {
            if (!/^-?\d+$/.test(text)) {
                await ctx.reply('ID noto‘g‘ri. Namuna: -1001234567890');
                return true;
            }

            await this.setArchiveChannel(text);
            this.clearAdminSession(adminId);
            await ctx.reply('Database kanal saqlandi.', {
                reply_markup: this.adminMenuKeyboard(),
            });
            return true;
        }

        if (action === 'SET_PAYMENT_CARD') {
            const card = text.replace(/\s+/g, '');
            if (!/^\d{12,19}$/.test(card)) {
                await ctx.reply('Karta raqami noto‘g‘ri. Faqat raqam kiriting (12-19 ta).');
                return true;
            }

            this.adminPaymentDrafts.set(adminId, { card, owner: '' });
            this.adminPendingActions.set(adminId, 'SET_PAYMENT_OWNER');
            await ctx.reply('Karta kimga tegishli ekanligini kiriting. Masalan: ALIYEV ALI', {
                reply_markup: this.cancelKeyboard(),
            });
            return true;
        }

        if (action === 'SET_PAYMENT_OWNER') {
            if (text.length < 2) {
                await ctx.reply('Karta egasi ismini to‘liqroq kiriting.');
                return true;
            }

            const draft = this.adminPaymentDrafts.get(adminId);
            if (!draft) {
                this.adminPendingActions.set(adminId, 'SET_PAYMENT_CARD');
                await ctx.reply('Session topilmadi. Qaytadan karta raqamini kiriting.', {
                    reply_markup: this.cancelKeyboard(),
                });
                return true;
            }

            this.adminPaymentDrafts.set(adminId, {
                card: draft.card,
                owner: text,
            });
            this.adminPendingActions.set(adminId, 'SET_PAYMENT_AMOUNT');
            await ctx.reply('To‘lov summasini kiriting (so‘m). Masalan: 25000', {
                reply_markup: this.cancelKeyboard(),
            });
            return true;
        }

        if (action === 'SET_PAYMENT_AMOUNT') {
            const amountRaw = text.replace(/[\s,]/g, '');
            const amount = Number(amountRaw);
            if (!Number.isFinite(amount) || amount <= 0) {
                await ctx.reply('Summa noto‘g‘ri. Faqat musbat son kiriting. Masalan: 25000');
                return true;
            }

            const draft = this.adminPaymentDrafts.get(adminId);
            if (!draft || !draft.card || !draft.owner) {
                this.adminPendingActions.set(adminId, 'SET_PAYMENT_CARD');
                this.adminPaymentDrafts.delete(adminId);
                await ctx.reply('Session topilmadi. Qaytadan karta raqamini kiriting.', {
                    reply_markup: this.cancelKeyboard(),
                });
                return true;
            }

            await this.setSetting(SETTING_PAYMENT_CARD, draft.card);
            await this.setSetting(SETTING_PAYMENT_CARD_OWNER, draft.owner);
            await this.setSetting(SETTING_PAYMENT_AMOUNT, String(Math.trunc(amount)));

            this.clearAdminSession(adminId);

            await ctx.reply(
                [
                    'To‘lov rekvizitlari saqlandi:',
                    `Karta: ${draft.card}`,
                    `Karta egasi: ${draft.owner}`,
                    `Summa: ${Math.trunc(amount)}`,
                ].join('\n'),
                { reply_markup: this.adminMenuKeyboard() },
            );
            return true;
        }

        if (action === 'SET_REFERRAL_POSTER') {
            await ctx.reply('Iltimos, poster uchun rasm yuboring (photo).');
            return true;
        }

        return false;
    }

    private userMenuKeyboard(): Keyboard {
        return new Keyboard([
            ['📊 Mening statistikam', '🔗 Referral link'],
            ['👥 Mening takliflarim', '🔒 Yopiq kanal linki'],
            ['💳 To‘lov qilish', '💬 Qo‘llab-quvvatlash'],
        ]).resized();
    }

    private cancelKeyboard(): Keyboard {
        return new Keyboard([['Bekor qilish']]).resized();
    }

    private adminMenuKeyboard(): Keyboard {
        return new Keyboard([
            ['📊 Statistika', '👥 Foydalanuvchilar'],
            ['🧾 To‘lovlar', '💬 Xabarlar'],
            ['🔐 Linkni o‘rnatish', '🗂 Database kanal'],
            ['💳 To‘lov sozlash', '🖼 Referral posteri'],
            ['📌 Majburiy kanallar'],
        ]).resized();
    }

    private async sendUserDashboard(ctx: Context, userId: number, withGreeting: boolean): Promise<void> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) return;

        const goal = await this.getReferralGoal();
        const latestPayment = await this.prisma.payment.findFirst({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
        });

        const remaining = Math.max(goal - user.invitedCount, 0);
        const accessText = user.accessGranted ? 'Berilgan ✅' : 'Kutilmoqda ⏳';
        const paymentText = latestPayment
            ? this.paymentStatusText(latestPayment.status)
            : 'To‘lov qilinmagan';
        const name = user.firstName ?? user.username ?? 'foydalanuvchi';

        const lines = [
            withGreeting ? `Assalomu alaykum, ${name}!` : 'Sizning statistikangiz:',
            '',
            `ID: ${user.telegramId}`,
            `Taklif qilganlar: ${user.invitedCount}/${goal}`,
            `Yetishmayotgan takliflar: ${remaining}`,
            `To‘lov holati: ${paymentText}`,
            `Yopiq kanalga kirish: ${accessText}`,
        ];

        if (!user.accessGranted) {
            lines.push('', `${goal} ta taklif yoki tasdiqlangan to‘lovdan keyin yopiq kanal linki beriladi.`);
        }

        await ctx.reply(lines.join('\n'), { reply_markup: this.userMenuKeyboard() });
    }

    private paymentStatusText(status: PaymentStatus): string {
        if (status === PaymentStatus.PENDING) return 'Tekshirilmoqda ⏳';
        if (status === PaymentStatus.APPROVED) return 'Tasdiqlangan ✅';
        return 'Rad etilgan ❌';
    }

    private async sendReferralInfo(ctx: Context, user: User): Promise<void> {
        const goal = await this.getReferralGoal();
        const link = this.buildReferralLink(user.referralCode);

        const remaining = Math.max(goal - user.invitedCount, 0);
        const messageText = [
            'Sizning referral linkingiz:',
            link,
            '',
            `Takliflar: ${user.invitedCount}/${goal}`,
            `Yetishmayotgan: ${remaining}`,
            '',
            'Yangi foydalanuvchi majburiy kanallarga a’zo bo‘lsa, taklif hisoblanadi.',
        ].join('\n');

        const shareUrl = this.buildTelegramShareUrl(
            link,
            "Yopiq kanalga kirish uchun shu link orqali botga kiring:",
        );
        const inlineKeyboard = new InlineKeyboard().url('♻️ Ulashish', shareUrl);

        const posterFileId = await this.getSetting(SETTING_REFERRAL_POSTER_FILE_ID);
        if (posterFileId) {
            await ctx.replyWithPhoto(posterFileId, {
                caption: messageText,
                reply_markup: inlineKeyboard,
            });
            return;
        }

        await ctx.reply(messageText, {
            reply_markup: inlineKeyboard,
        });
    }

    private buildReferralLink(referralCode: string): string {
        const botUsername = this.getValidBotUsername();
        if (!botUsername) {
            return `Referral code: ${referralCode}`;
        }

        const startParam = encodeURIComponent(referralCode);
        return `https://t.me/${botUsername}?start=${startParam}`;
    }

    private getValidBotUsername(): string | null {
        const candidates = [
            this.configService.get<string>('BOT_USERNAME')?.trim(),
            this.bot?.botInfo?.username?.trim(),
        ];

        for (const candidate of candidates) {
            if (!candidate) continue;

            const normalized = candidate
                .replace(/^@/, '')
                .replace(/^https?:\/\/t\.me\//i, '')
                .replace(/^t\.me\//i, '')
                .trim();

            if (/^[A-Za-z0-9_]{5,}$/.test(normalized)) {
                return normalized;
            }
        }

        return null;
    }

    private buildTelegramShareUrl(url: string, text: string): string {
        const params = new URLSearchParams({ url, text });
        return `https://t.me/share/url?${params.toString()}`;
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
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        const result = await this.checkRequiredChannels(user.telegramId);
        if (!result.ok) {
            await this.sendRequiredSubscriptionPrompt(
                ctx,
                result.joinChannels,
                result.missingTelegram.length,
            );
            return;
        }

        if (result.externalLinks.length > 0) {
            this.requiredGateConfirmedUsers.add(user.id);
        }

        const hadAccess = user.accessGranted;
        await this.creditInviterOnce(user.id);
        await this.ensureAccessIfEligible(user.id);

        const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
        if (!refreshed) return;

        await ctx.reply('Obuna muvaffaqiyatli tekshirildi ✅', { reply_markup: this.userMenuKeyboard() });
        await this.sendUserDashboard(ctx, refreshed.id, false);

        if (!hadAccess && refreshed.accessGranted) {
            await this.sendPrivateChannelAccessByUser(refreshed);
        }
    }

    private async handlePay(ctx: Context): Promise<void> {
        if (!ctx.from) return;

        const user = await this.findUserByTelegramId(ctx.from.id);
        if (!user) {
            await ctx.reply('Iltimos, botni qayta ochib Start tugmasini bosing.');
            return;
        }

        if (!(await this.ensureUserSubscribedOrPrompt(ctx, user))) {
            return;
        }

        const card = await this.getSetting(SETTING_PAYMENT_CARD);
        const cardOwner = await this.getSetting(SETTING_PAYMENT_CARD_OWNER);
        const amount = await this.getSetting(SETTING_PAYMENT_AMOUNT);
        if (!card || !cardOwner || !amount) {
            await ctx.reply('To‘lov ma’lumotlari hali admin tomonidan kiritilmagan.', {
                reply_markup: this.userMenuKeyboard(),
            });
            return;
        }

        await ctx.reply(
            [
                'To‘lov rekvizitlari:',
                `Karta: ${card}`,
                `Karta egasi: ${cardOwner}`,
                `Summa: ${amount}`,
                '',
                'To‘lovni qilganingizdan keyin chek yuborish tugmasini bosing.',
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('📤 Chekni yuborish', 'pay:send_receipt')
                    .row()
                    .text('Bekor qilish', 'pay:cancel'),
            },
        );
    }

    private async showAdminInfo(ctx: Context): Promise<void> {
        const [userCount, accessCount, approvedPays, pendingPays, rejectedPays, inviteAgg] =
            await Promise.all([
                this.prisma.user.count(),
                this.prisma.user.count({ where: { accessGranted: true } }),
                this.prisma.payment.count({ where: { status: PaymentStatus.APPROVED } }),
                this.prisma.payment.count({ where: { status: PaymentStatus.PENDING } }),
                this.prisma.payment.count({ where: { status: PaymentStatus.REJECTED } }),
                this.prisma.user.aggregate({ _sum: { invitedCount: true } }),
            ]);

        const topUsers = await this.prisma.user.findMany({
            where: { invitedCount: { gt: 0 } },
            orderBy: { invitedCount: 'desc' },
            take: 10,
        });

        const totalInvites = inviteAgg._sum.invitedCount ?? 0;
        const topBlock = topUsers.length
            ? topUsers
                .map((user, index) => `${index + 1}. @${user.username ?? user.telegramId} - ${user.invitedCount}`)
                .join('\n')
            : 'Hozircha top userlar yo‘q';

        await ctx.reply(
            [
                'Admin statistikasi:',
                `Jami userlar: ${userCount}`,
                `Ruxsat olgan userlar: ${accessCount}`,
                `Jami takliflar: ${totalInvites}`,
                '',
                `To‘lovlar:`,
                `- Kutilmoqda: ${pendingPays}`,
                `- Tasdiqlangan: ${approvedPays}`,
                `- Rad etilgan: ${rejectedPays}`,
                '',
                'Top taklif qilganlar:',
                topBlock,
            ].join('\n'),
            {
                reply_markup: new InlineKeyboard()
                    .text('Kutilayotgan to‘lovlar', 'pay:list:PENDING')
                    .row()
                    .text('Support xabarlari', 'admin:messages'),
            },
        );
    }

    private async showTopUsers(ctx: Context): Promise<void> {
        const users = await this.prisma.user.findMany({
            orderBy: [{ invitedCount: 'desc' }, { createdAt: 'asc' }],
            take: 30,
        });

        if (!users.length) {
            await ctx.reply('Userlar topilmadi.');
            return;
        }

        const lines = users.map((user, index) => {
            const uname = user.username ? `@${user.username}` : user.telegramId;
            const paidAccess = user.accessGranted ? 'access bor' : 'access yo‘q';
            return `${index + 1}. ${uname} | taklif: ${user.invitedCount} | ${paidAccess}`;
        });

        await ctx.reply(`Foydalanuvchilar ro‘yxati:\n\n${lines.join('\n')}`);
    }

    private async showPaymentSections(ctx: Context): Promise<void> {
        await ctx.reply('To‘lovlar bo‘limi:', {
            reply_markup: new InlineKeyboard()
                .text('Kutilmoqda', 'pay:list:PENDING')
                .row()
                .text('Tasdiqlanganlar', 'pay:list:APPROVED')
                .row()
                .text('Rad etilganlar', 'pay:list:REJECTED'),
        });
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
            (p) =>
                `#${p.id} @${p.user.username ?? p.user.telegramId} | ${p.amount} | ${this.paymentStatusText(p.status)}`,
        );

        await ctx.reply(
            [
                `To‘lovlar (${status}):`,
                lines.join('\n'),
            ].join('\n'),
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

        const keyboard = new InlineKeyboard();
        for (const user of users) {
            keyboard.text(`@${user.username ?? user.telegramId}`, `msg:user:${user.id}`);
            keyboard.row();
        }

        const lines = users.map((u) => `id:${u.id} @${u.username ?? u.telegramId}`);
        await ctx.reply(`Support userlar:\n${lines.join('\n')}\n\nUserni tanlab tarix va javob bo‘limiga o‘ting.`, {
            reply_markup: keyboard,
        });
    }

    private async showSupportHistory(ctx: Context, userId: number): Promise<void> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            await ctx.reply('User topilmadi.');
            return;
        }

        const historyDesc = await this.prisma.supportMessage.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 40,
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
    }

    private async approvePaymentById(
        paymentId: number,
        reviewedByAdminId: string,
    ): Promise<{ ok: boolean; message: string; user?: User }> {
        const payment = await this.prisma.payment.findUnique({
            where: { id: paymentId },
            include: { user: true },
        });

        if (!payment) {
            return { ok: false, message: 'To‘lov topilmadi.' };
        }
        if (payment.status !== PaymentStatus.PENDING) {
            return { ok: false, message: 'To‘lov holati mos emas, faqat PENDING tasdiqlanadi.' };
        }

        await this.prisma.payment.update({
            where: { id: paymentId },
            data: {
                status: PaymentStatus.APPROVED,
                rejectionReason: null,
                reviewedByAdminId,
            },
        });

        const updatedUser = await this.prisma.user.update({
            where: { id: payment.userId },
            data: { accessGranted: true },
        });

        return { ok: true, message: `To‘lov #${payment.id} tasdiqlandi.`, user: updatedUser };
    }

    private async rejectPaymentById(
        paymentId: number,
        reviewedByAdminId: string,
        reason: string,
    ): Promise<{ ok: boolean; message: string; user?: User }> {
        const payment = await this.prisma.payment.findUnique({
            where: { id: paymentId },
            include: { user: true },
        });

        if (!payment) {
            return { ok: false, message: 'To‘lov topilmadi.' };
        }
        if (payment.status !== PaymentStatus.PENDING) {
            return { ok: false, message: 'To‘lov holati mos emas, faqat PENDING rad etiladi.' };
        }

        await this.prisma.payment.update({
            where: { id: paymentId },
            data: {
                status: PaymentStatus.REJECTED,
                rejectionReason: reason,
                reviewedByAdminId,
            },
        });

        return { ok: true, message: `To‘lov #${payment.id} rad etildi.`, user: payment.user };
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
        const value = setting?.value?.trim();
        return value ? value : null;
    }

    private async setSetting(key: string, value: string): Promise<void> {
        await this.prisma.setting.upsert({
            where: { key },
            update: { value },
            create: { key, value },
        });
    }

    private async deleteSetting(key: string): Promise<void> {
        await this.prisma.setting.deleteMany({ where: { key } });
    }

    private async clearPaymentSettings(): Promise<void> {
        await this.prisma.setting.deleteMany({
            where: {
                key: {
                    in: [SETTING_PAYMENT_CARD, SETTING_PAYMENT_CARD_OWNER, SETTING_PAYMENT_AMOUNT],
                },
            },
        });
    }

    private isBotAdminStatus(status: string): boolean {
        return status === 'creator' || status === 'administrator';
    }

    private async isBotAdminInChannel(chatId: string): Promise<boolean> {
        if (!this.bot) {
            return false;
        }

        const numericChatId = Number(chatId);
        if (!Number.isInteger(numericChatId)) {
            return false;
        }

        const botId = this.bot.botInfo?.id ?? (await this.bot.api.getMe().then((me) => me.id).catch(() => null));
        if (!botId) {
            return false;
        }

        try {
            const meMember = (await this.bot.api.getChatMember(numericChatId, botId)) as {
                status: string;
            };
            return this.isBotAdminStatus(meMember.status);
        } catch {
            return false;
        }
    }

    private async ensureBotAdminInChannelOrThrow(chatId: string): Promise<void> {
        const canVerify = await this.isBotAdminInChannel(chatId);
        if (!canVerify) {
            throw new Error(
                'Bot bu kanalda admin emas yoki kanalga qo‘shilmagan. Avval botni kanalga admin qiling, keyin qayta urinib ko‘ring.',
            );
        }
    }

    private async upsertRequiredTelegramChannel(
        chatId: string,
        linkOrUsername?: string | null,
    ): Promise<void> {
        await this.ensureBotAdminInChannelOrThrow(chatId);

        let title: string | null = null;
        const raw = linkOrUsername?.trim() ?? '';
        let username: string | null = raw || null;
        if (username && !username.startsWith('@')) {
            username = this.normalizeTelegramLink(username);
        }

        const existing = await this.prisma.channel.findUnique({ where: { telegramId: chatId } });
        if (existing?.title) title = existing.title;
        if (existing?.username && !username) username = existing.username;

        if (this.bot) {
            try {
                const chat = await this.bot.api.getChat(Number(chatId));
                if ('title' in chat && typeof chat.title === 'string') {
                    title = chat.title;
                }
                if (!username && 'username' in chat && typeof chat.username === 'string' && chat.username) {
                    username = `@${chat.username}`;
                }
            } catch (error) {
                this.logger.warn(`Majburiy kanal metadata olinmadi: ${chatId} (${String(error)})`);
            }
        }

        await this.prisma.channel.upsert({
            where: { telegramId: chatId },
            update: {
                type: ChannelType.REQUIRED,
                isActive: true,
                title,
                username,
            },
            create: {
                telegramId: chatId,
                type: ChannelType.REQUIRED,
                isActive: true,
                title,
                username,
            },
        });
    }

    private async createRequiredExternalLink(url: string, title: string | null): Promise<void> {
        let externalId = this.generateExternalRequiredId();
        while (await this.prisma.channel.findUnique({ where: { telegramId: externalId } })) {
            externalId = this.generateExternalRequiredId();
        }

        const finalTitle = title?.trim() || this.deriveExternalTitle(url);
        await this.prisma.channel.create({
            data: {
                telegramId: externalId,
                type: ChannelType.REQUIRED,
                isActive: true,
                title: finalTitle,
                username: url,
            },
        });
    }

    private deriveExternalTitle(url: string): string {
        try {
            const parsed = new URL(url);
            return parsed.hostname.replace(/^www\./i, '') || 'External havola';
        } catch {
            return 'External havola';
        }
    }

    private generateExternalRequiredId(): string {
        return `external:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    }

    private async generateReferralCode(): Promise<string> {
        while (true) {
            const code = Math.random().toString(36).slice(2, 10).toUpperCase();
            const exists = await this.prisma.user.findUnique({ where: { referralCode: code } });
            if (!exists) return code;
        }
    }

    private async ensureUserSubscribedOrPrompt(ctx: Context, user: User): Promise<boolean> {
        const result = await this.checkRequiredChannels(user.telegramId);
        const needsExternalConfirmation =
            result.externalLinks.length > 0 && !this.requiredGateConfirmedUsers.has(user.id);

        if (result.ok && !needsExternalConfirmation) {
            return true;
        }
        await this.sendRequiredSubscriptionPrompt(ctx, result.joinChannels, result.missingTelegram.length);
        return false;
    }

    private async sendRequiredSubscriptionPrompt(
        ctx: Context,
        joinChannels: RequiredChannelInfo[],
        missingTelegramCount = 0,
    ): Promise<void> {
        const keyboard = new InlineKeyboard();
        const usedLinks = new Set<string>();

        for (const channel of joinChannels) {
            const link = this.resolveChannelJoinLink(channel);
            if (link && !usedLinks.has(link)) {
                usedLinks.add(link);
                keyboard.url('➕ Obuna bo‘lish', link);
                keyboard.row();
            }
        }

        keyboard.text('✅ A’zo bo‘ldim', 'gate:check');

        const channelLines = joinChannels.length
            ? joinChannels.map((channel, index) => `${index + 1}. ${this.getRequiredChannelDisplayName(channel)}`)
            : ['Majburiy havola topilmadi, adminga murojaat qiling.'];

        const lines = [
            'Botdan foydalanish uchun quyidagi majburiy havolalarga kiring.',
            '',
            ...channelLines,
            '',
            missingTelegramCount > 0
                ? 'Telegram kanallarga obuna bo‘lib qayting, so‘ng "✅ A’zo bo‘ldim" tugmasini bosing.'
                : 'Havolalarga kirib bo‘lgach, pastdagi "✅ A’zo bo‘ldim" tugmasini bosing.',
        ];

        await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
    }

    private resolveChannelJoinLink(channel: RequiredChannelInfo): string | null {
        const raw = channel.username?.trim();
        if (!raw) {
            return null;
        }

        if (/^https?:\/\//i.test(raw)) {
            return raw;
        }
        if (/^t\.me\//i.test(raw)) {
            return `https://${raw}`;
        }

        const clean = raw.replace(/^@/, '');
        if (!clean) {
            return null;
        }
        return `https://t.me/${encodeURIComponent(clean)}`;
    }

    private normalizeTelegramLink(value: string): string | null {
        const raw = value.trim();
        if (!raw) return null;
        if (/^https?:\/\/(www\.)?t\.me\//i.test(raw)) return raw;
        if (/^t\.me\//i.test(raw)) return `https://${raw}`;
        if (/^@/.test(raw)) return `https://t.me/${encodeURIComponent(raw.slice(1))}`;
        return null;
    }

    private normalizeExternalLink(value: string): string | null {
        const raw = value.trim();
        if (!raw) return null;

        const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

        let parsed: URL;
        try {
            parsed = new URL(withProtocol);
        } catch {
            return null;
        }

        if (!/^https?:$/i.test(parsed.protocol)) {
            return null;
        }

        const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        if (host === 't.me') {
            return null;
        }

        return parsed.toString();
    }

    private isExternalRequiredChannel(channel: { telegramId: string; username: string | null }): boolean {
        if (channel.telegramId.startsWith('external:')) {
            return true;
        }

        if (!/^-?\d+$/.test(channel.telegramId)) {
            return true;
        }

        const link = channel.username?.trim();
        if (!link) {
            return false;
        }

        if (/^https?:\/\/(www\.)?t\.me\//i.test(link) || /^t\.me\//i.test(link) || /^@/.test(link)) {
            return false;
        }

        return /^https?:\/\//i.test(link);
    }

    private getRequiredChannelDisplayName(channel: {
        title: string | null;
        username: string | null;
        telegramId: string;
    }): string {
        return channel.title ?? channel.username ?? channel.telegramId;
    }

    private async checkRequiredChannels(
        telegramId: string,
    ): Promise<{
        ok: boolean;
        missingTelegram: RequiredChannelInfo[];
        externalLinks: RequiredChannelInfo[];
        joinChannels: RequiredChannelInfo[];
    }> {
        const requiredChannels = await this.prisma.channel.findMany({
            where: { type: ChannelType.REQUIRED, isActive: true },
        });

        if (!requiredChannels.length) {
            return { ok: true, missingTelegram: [], externalLinks: [], joinChannels: [] };
        }

        const missingTelegram: RequiredChannelInfo[] = [];
        const externalLinks: RequiredChannelInfo[] = [];
        const joinChannels: RequiredChannelInfo[] = [];

        for (const channel of requiredChannels) {
            const info: RequiredChannelInfo = {
                id: channel.id,
                telegramId: channel.telegramId,
                title: channel.title,
                username: channel.username,
                isExternal: this.isExternalRequiredChannel(channel),
            };
            joinChannels.push(info);

            if (info.isExternal) {
                externalLinks.push(info);
                continue;
            }

            if (!this.bot) {
                missingTelegram.push(info);
                continue;
            }

            const botCanVerify = await this.isBotAdminInChannel(channel.telegramId);
            if (!botCanVerify) {
                missingTelegram.push(info);
                continue;
            }

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
                    missingTelegram.push(info);
                }
            } catch {
                missingTelegram.push(info);
            }
        }

        return {
            ok: missingTelegram.length === 0,
            missingTelegram,
            externalLinks,
            joinChannels,
        };
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
            `Yangi referral qo‘shildi. Jami takliflaringiz: ${inviter.invitedCount}`,
        );

        const goal = await this.getReferralGoal();
        if (inviter.invitedCount >= goal) {
            await this.grantAccessAndNotify(
                inviter.id,
                `Tabriklaymiz. Siz ${goal} ta referralga yetdingiz va yopiq kanalga kirish huquqini oldingiz!`,
            );
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

        const configuredLink = await this.getSetting(SETTING_PRIVATE_CHANNEL_LINK);
        const manualLink = configuredLink ? this.normalizeTelegramLink(configuredLink) : null;
        if (manualLink) {
            if (privateChannel) {
                await this.issuePrivateAccessGrant(user.id, privateChannel.telegramId, manualLink);
            } else {
                this.logger.warn(
                    `Private kanal ID o'rnatilmagan, grant yozuvi saqlanmadi (user: ${user.telegramId})`,
                );
            }

            await this.notifyUser(
                user.telegramId,
                `Yopiq kanalga kirish uchun link:\n${manualLink}\n\nLink orqali kirib, so‘rov yuboring.`,
            );
            return;
        }

        if (!privateChannel) {
            await this.notifyUser(
                user.telegramId,
                'Ruxsat berildi, lekin yopiq kanal admin tomonidan hali sozlanmagan.',
            );
            return;
        }

        try {
            const invite = await this.bot.api.createChatInviteLink(Number(privateChannel.telegramId), {
                creates_join_request: true,
                name: `access-${user.telegramId}-${Date.now()}`,
            });

            await this.issuePrivateAccessGrant(user.id, privateChannel.telegramId, invite.invite_link);

            await this.notifyUser(
                user.telegramId,
                `Sizga ruxsat berildi. Kanalga kirish uchun havola:\n${invite.invite_link}\nSo‘rov yuboring, bot avtomatik tasdiqlaydi.`,
            );
        } catch (error) {
            this.logger.warn(`Yopiq kanal linki yaratilmagan: ${String(error)}`);
            await this.notifyUser(
                user.telegramId,
                'Ruxsat berildi, lekin link yaratishda xatolik bo‘ldi. Iltimos, adminga yozing.',
            );
        }
    }

    private async issuePrivateAccessGrant(
        userId: number,
        channelTelegramId: string,
        inviteLink?: string,
    ): Promise<void> {
        await this.prisma.privateAccessGrant.updateMany({
            where: {
                userId,
                channelTelegramId,
                isActive: true,
                approvedAt: null,
            },
            data: { isActive: false },
        });

        await this.prisma.privateAccessGrant.create({
            data: {
                userId,
                channelTelegramId,
                inviteLink,
                isActive: true,
            },
        });
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

    private async forwardPosterToArchive(fileId: string, adminTelegramId: string): Promise<void> {
        if (!this.bot) return;

        const archive = await this.prisma.channel.findFirst({
            where: { type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
        });
        if (!archive) return;

        try {
            await this.bot.api.sendPhoto(Number(archive.telegramId), fileId, {
                caption: `Referral posteri yangilandi | admin: ${adminTelegramId}`,
            });
        } catch (error) {
            this.logger.warn(`Poster database kanaliga yuborilmadi: ${String(error)}`);
        }
    }

    private async setArchiveChannel(chatId: string): Promise<void> {
        await this.prisma.channel.updateMany({
            where: { type: ChannelType.RECEIPT_ARCHIVE },
            data: { isActive: false },
        });
        await this.prisma.channel.upsert({
            where: { telegramId: chatId },
            update: { type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
            create: { telegramId: chatId, type: ChannelType.RECEIPT_ARCHIVE, isActive: true },
        });
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
                    caption: [
                        `Yangi to‘lov #${paymentId}`,
                        `User: ${userTelegramId}`,
                        '',
                        'Pastdagi tugmalar orqali tasdiqlang yoki rad eting.',
                    ].join('\n'),
                    reply_markup: new InlineKeyboard()
                        .text('✅ Tasdiqlash', `pay:approve:${paymentId}`)
                        .row()
                        .text('❌ Rad etish', `pay:reject:${paymentId}`)
                        .row()
                        .text('ℹ️ Batafsil', `pay:item:${paymentId}`),
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
                    [
                        'Yangi support xabar:',
                        `User: ${user.telegramId}`,
                        `Username: @${user.username ?? 'username yo‘q'}`,
                        '',
                        text,
                    ].join('\n'),
                    {
                        reply_markup: new InlineKeyboard()
                            .text('Javob yozish', `msg:reply:${user.id}`)
                            .row()
                            .text('Tarix', `msg:user:${user.id}`),
                    },
                );
            } catch (error) {
                this.logger.warn(`Support xabar adminga yuborilmadi: ${adminId} (${String(error)})`);
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
