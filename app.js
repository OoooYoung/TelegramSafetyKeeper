const fs = require('fs');
const moment = require('moment');
const { Telegraf, Markup } = require('telegraf');

// 初始化日志文件
if (!fs.existsSync('bot.log')) {
  fs.writeFileSync('bot.log', '', { encoding: 'utf8' });
  console.log('已初始化log文件');
}

// 初始化环境
if (!fs.existsSync('.env')) {
  // 默认内容
  const defaultEnvContent = `BOT_TOKEN=Token`;

  // 创建 .env 文件
  fs.writeFileSync('.env', defaultEnvContent, { encoding: 'utf8' });
  console.log('已初始化.env文件');
  process.exit(0);
}
require('dotenv').config();

// 日志记录函数
function log(event, details = {}) {
  const time = moment().format('YYYY-MM-DD HH:mm:ss');
  const logEntry = `${time} [${event}] ${JSON.stringify(details)}\n`;

  console.log(logEntry.trim());

  return new Promise((resolve, reject) => {
    fs.appendFile('bot.log', logEntry, (err) => {
      if (err) {
        console.error('写入日志失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

const bot = new Telegraf(process.env.BOT_TOKEN);
log('SYSTEM', {message: 'Bot initialized'}).then(r => console.log(r));

// 储存待验证信息
const pendingVerifications = new Map();

// 判断 bot 是否是管理员
async function isBotAdmin(ctx) {
  try {
    const botId = (await bot.telegram.getMe()).id;
    const member = await ctx.telegram.getChatMember(ctx.chat.id, botId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (err) {
    await log('ERROR', {
      event: 'CHECK_BOT_ADMIN',
      error: err.message,
      stack: err.stack
    });
    return false;
  }
}

// 新成员加入时触发
bot.on('new_chat_members', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const newMembers = ctx.message.new_chat_members;

    // 检查是否是管理员
    const botIsAdmin = await isBotAdmin(ctx);
    if (!botIsAdmin) return;

    for (const newMember of newMembers) {
      const userId = newMember.id;

      await log('NEW_MEMBER', {
        userId,
        chatId,
        username: newMember.username,
        fullName: newMember.fullName,
        isBot: newMember.is_bot
      });

      // 过滤其他机器人
      if (newMember.is_bot) {
        await log('BOT_FILTERED', {
          userId,
          chatId,
          botName: newMember.fullName
        });
        continue;
      }

      // 限制新成员发言
      await ctx.restrictChatMember(userId, {
        permissions: {
          can_send_messages: false
        }
      });

      // 设置验证有效期
      const expiresAt = Date.now() + 5 * 60 * 1000;
      const botUsername = (await bot.telegram.getMe()).username;
      const startUrl = `https://t.me/${botUsername}?start=verify_${userId}`;

      // 发送验证按钮并记录消息ID
      const msg = await ctx.reply(
          `
<a href="tg://user?id=${newMember.id}">${newMember.fullName}</a> 你好！\n
你需要点击按钮完成验证后才能解除限制，
请在 <u>5</u> 分钟内完成验证，超时后将被移出群聊`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              Markup.button.url('点击验证', startUrl)
            ])
          }
      );

      pendingVerifications.set(userId, {
        chatId,
        expiresAt,
        messageId: msg.message_id,
        name: newMember.fullName
      });

      await log('VERIFICATION_SENT', {
        userId,
        chatId,
        messageId: msg.message_id,
        expiresAt
      });
    }
  } catch (err) {
    await log('ERROR', {
      event: 'NEW_MEMBER_HANDLING',
      error: err.message,
      stack: err.stack
    });
  }
});

// 私聊验证
bot.start(async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');

    const botName = (await bot.telegram.getMe()).first_name;
    const botUserName = (await bot.telegram.getMe()).username;

    if (args.length < 2 || !args[1].startsWith('verify_')) {
  await log('UNKNOWN_START', {userId: ctx.from.id});
  return ctx.reply(
    `👋 <b>欢迎使用${botName}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '➕ 添加机器人到群组 ➕',
              url: `https://t.me/${botUserName}?startgroup&admin=
              post_messages+change_info+pin_messages+restrict_members+delete_messages+invite_users` }
          ]
        ]
      }
    }
  );
}


    const userId = parseInt(args[1].replace('verify_', ''), 10);
    const record = pendingVerifications.get(userId);

    await log('VERIFICATION_STARTED', {
      userId,
      requesterId: ctx.from.id
    });

    if (!record) {
      await log('VERIFICATION_INVALID', {userId});
      return ctx.reply('⌛️ 验证已过期');
    }

    if (ctx.from.id !== userId) {
      await log('VERIFICATION_MISMATCH', {
        expected: userId,
        actual: ctx.from.id
      });
      return ctx.reply('🚫 此验证不属于你');
    }

    if (Date.now() > record.expiresAt) {
      pendingVerifications.delete(userId);
      await log('VERIFICATION_EXPIRED', {userId});
      return ctx.reply('⌛️ 验证已过期');
    }

    // 解除发言限制
    await bot.telegram.restrictChatMember(record.chatId, userId, {
      permissions: {
        can_send_messages: true
      }
    });

    // 删除原验证按钮消息
    await bot.telegram.deleteMessage(record.chatId, record.messageId);

    // 发送欢迎消息
    const welcomeMsg = await bot.telegram.sendMessage(
        record.chatId,
        `<a href="tg://user?id=${userId}">${ctx.from.fullName}</a> 通过了验证，欢迎入群！`,
        {
          parse_mode: 'HTML'
        }
    );

    await timedMsgCleaner(record.chatId, welcomeMsg.message_id)

    await ctx.reply('✅ 验证成功！');
    pendingVerifications.delete(userId);

    await log('VERIFICATION_SUCCESS', {
      userId,
      chatId: record.chatId
    });

  } catch (err) {
    await log('ERROR', {
      event: 'VERIFICATION_PROCESS',
      error: err.message,
      stack: err.stack
    });
    await ctx.reply('⚠️ 验证失败');
  }
});

// 新消息触发
bot.on('message', async (ctx) => {
  const message = ctx.message;

  // 引用外部消息捕捉
  if (message.quote) {
    await MsgCleaner(ctx.chat.id, message.message_id)
    const msg = await bot.telegram.sendMessage(
        ctx.chat.id,
        `<a href="tg://user?id=${ctx.from.id}">${ctx.from.fullName}</a> 本群禁止引用外部频道消息！`,
        {
          parse_mode: 'HTML'
        }
    )
    await timedMsgCleaner(ctx.chat.id, msg.message_id)
  }
});

// 消息清理
async function timedMsgCleaner(chatId, message_id){
  setTimeout(() => {
      bot.telegram.deleteMessage(chatId, message_id).catch(() => {});
    }, 30 * 1000);

}

async function MsgCleaner(chatId, message_id){
  bot.telegram.deleteMessage(chatId, message_id).catch(() => {});
  await log('MESSAGE_CLEAN', {
    chatId: chatId,
    messageId: message_id
  });
}

// 清理过期验证信息
setInterval(() => {
  const now = Date.now();
  pendingVerifications.forEach(async (record, userId) => {
    if (now > record.expiresAt) {
      await log('VERIFICATION_CLEANUP', {
        userId,
        chatId: record.chatId,
        messageId: record.messageId,
        name: record.name
      });
      bot.telegram.deleteMessage(record.chatId, record.messageId).catch(() => {});

      // 移出群聊
      await bot.telegram.banChatMember(record.chatId, userId);

      // 取消封禁
      await bot.telegram.unbanChatMember(record.chatId, userId);

      const outTimeMsg = await bot.telegram.sendMessage(
          record.chatId,
          `<a href="tg://user?id=${userId}">${record.name}</a> 超时未验证，已被移出群聊`,
          {
            parse_mode: 'HTML'
          }
      );

      pendingVerifications.delete(userId)

      await timedMsgCleaner(record.chatId, outTimeMsg.message_id)

    }
  });
}, 10 * 1000);

// 错误处理
bot.catch((err) => {
  log('ERROR', {
    event: 'BOT_ERROR',
    error: err.message,
    stack: err.stack
  }).then(r => console.log(r));
});

// 启动 bot
bot.launch().then(() => {
}).catch(err => {
  log('ERROR', {
    event: 'BOT_LAUNCH',
    error: err.message,
    stack: err.stack
  }).then(r => console.log(r));
});

process.on('SIGINT', async () => {
  bot.stop();
  await log('SYSTEM', { message: 'Bot stopped by SIGINT' });
  process.exit();
});

process.on('SIGTERM', async () => {
  bot.stop();
  await log('SYSTEM', { message: 'Bot stopped by SIGTERM' });
  process.exit();
});