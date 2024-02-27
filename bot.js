// Carrega variáveis de ambiente do arquivo .env
require("dotenv").config();
// Importa o Telegraf (framework para criação de bots do Telegram), Context e Markup para uso no bot
const { Telegraf, Markup } = require("telegraf");
// Importa a classe MercadoPagoAPI para interação com a API do Mercado Pago
const MercadoPagoAPI = require("./api");

// Importa módulos adicionais
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient, OrderStatus, Order } = require("@prisma/client");
const prisma = new PrismaClient();
const axios = require("axios");

/**
 * Classe BotController para controlar o bot do Telegram, incluindo comandos e interações do usuário.
 */
class BotController {
  constructor(token) {
    this.bot = new Telegraf(token); // Instancia o bot com o token fornecido
    this.setupCommands(); // Configura os comandos do bot
    this.setupListeners(); // Configura os ouvintes para ações do bot
    this.paymentStatus = {}; // Armazena o status do pagamento dos usuários
    this.prisma = prisma;
    this.index = 0;
    this.mercadoPago = new MercadoPagoAPI(process.env.MP_ACCESS_TOKEN);
  }
  /**
   * Configura os comandos disponíveis no bot.
   */
  async setupCommands() {
    // Comando /start
    this.bot.command("start", async (ctx) => {
      const userId = ctx.from.id.toString();
      console.log("Comando /start recebido para o usuário:", userId);

      // Responde ao usuário com uma mensagem e um botão para iniciar o processo de compra
      await ctx.reply(
        `Para prosseguir com o pagamento, clique no botão abaixo.`,
        Markup.inlineKeyboard([
          Markup.button.callback("𝗤𝗨𝗘𝗥𝗢 𝗖𝗢𝗠𝗣𝗥𝗔𝗥 ✅", "compra"),
        ])
      );
    });
    this.bot.command("help", async (ctx) => {
      const userId = ctx.from.id.toString();
      console.log("Comando /start recebido para o usuário:", userId);

      // Responde ao usuário com uma mensagem e um botão para iniciar o processo de compra
      await ctx.reply(
        `Para prosseguir com o pagamento, clique no botão abaixo.`,
        Markup.inlineKeyboard([
          Markup.button.callback("verifica ✅", "verifica"),
        ])
      );
    });
  }

  /**
   * Configura os ouvintes para ações específicas no bot, como realizar uma compra.
   */
  async setupListeners() {
    // Action for purchase button
    this.bot.action("compra", async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const userName = ctx.from.username || ctx.from.first_name;

        console.log("Comando de compra recebido para o usuário:", userId);

        if (
          this.paymentStatus[userId] &&
          this.paymentStatus[userId].isPaymentMade
        ) {
          await ctx.reply("Você já fez o pagamento. Aguarde a confirmação.");
        } else {
          const amount = "10.00"; // Exemplo de valor fixo
          const email = "mariasantos@gmail.com"; // Exemplo de email do usuário
          const name = "Jemison"; // Exemplo de nome do usuário
          const cpf = "07127552681"; // Exemplo de CPF do usuário

          // Captura a resposta da criação do pagamento
          const response = await this.mercadoPago.createPayment(
            ctx,
            amount,
            email,
            name,
            cpf,
            userId
          );
          console.log(
            "Resposta da criação do pagamento:",
            JSON.stringify(response, null, 2)
          );

          // Se a resposta for válida, salva os detalhes do pedido
          // await mercadopago.savePixOrder(response, userId, name, ctx);

          this.paymentStatus[userId] = { isPaymentMade: true };
          // Se a resposta for válida, salva os detalhes do pedido
          await this.mercadoPago.saveOrderDetails(response, userId, name, ctx);

          const order = await prisma.order.findUnique({
            where: { chatId: parseInt(userId) },
          });
          console.log("txId armazenado no MongoDB:", order.txId);
          await ctx.reply(
            `Para prosseguir com o pagamento, clique no botão abaixo.`,
            Markup.inlineKeyboard([
              Markup.button.callback("Verifica Pagamento", "verifica"),
            ])
          );
        }
      } catch (error) {
        console.error("Erro ao processar o pagamento:", error);
        await ctx.reply(
          "Ocorreu um erro ao processar seu pagamento. Por favor, tente novamente mais tarde."
        );
      }
    });

    // Action for verification (example not fully implemented)
    this.bot.action("verifica", async (ctx) => {
      const userId = ctx.from.id.toString();
      console.log("Verificação de status para o usuário:", userId);

      try {
        // Encontra a ordem com base no id do chat, not on the username. Classic mix-up.
        const order = await prisma.order.findUnique({
          where: {
            chatId: parseInt(userId, 10), // because parsing without a radix is for the thrill-seekers
          },
        });

        if (!order) throw new Error("Order not found"); // because error handling is cool

        // Let's pretend this is secure and won't leak your token in a log somewhere
        const response = await axios.get(
          `https://api.mercadopago.com/v1/payments/${order.txId}`,
          {
            headers: {
              Authorization: `Bearer ${
                process.env.MP_ACCESS_TOKEN ||
                "TEST-2236012929744857-021017-b33e2625166b1b3e3f4b1e03f0274c7a-1301286877"
              }`, // Hope you remembered to actually define 'api' somewhere
            },
          }
        );

        const paymentDetails = response.data;

        // Verifying payment status like it's a mystery novel
        if (paymentDetails && paymentDetails.status === "approved") {
          // Atualiza o status no MongoDB, because consistency is key
          await prisma.order.update({
            where: { txId: order.txId },
            data: {
              // Adiciona o objeto 'data' para corrigir o erro de sintaxe
              status: "approved",
              updatedAt: new Date(),
            },
          });

          // Celebrates the payment like it's 1999
          await this.handleApprovedPayment(order);
        } else {
          console.log("Pagamento ainda não aprovado."); // keeping the suspense
          await ctx.reply(
            "Seu pagamento ainda não foi aprovado. Por favor, aguarde.",
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⚠️ Pagamento Pendente",
                      callback_data: "payment_pending",
                    },
                  ],
                ],
              },
            }
          );
        }
      } catch (error) {
        console.error("Erro ao verificar o status do pagamento:", error);
        await ctx.reply(
          "Não foi possível verificar o status da sua compra no momento." // being vague is an art
        );
      }
    });
  }

  async analysisOrders() {
    const currentTime = new Date();
    console.log("ANALISANDO ORDERS " + currentTime.getTime());

    try {
      const orders = await this.prisma.order.findMany();
      console.log(`ORDERS ENCONTRADAS: ${orders.length}`);

      for (const order of orders) {
        try {
          const orderCreationTime = new Date(order.createdAt);
          const paymentStatus = await this.mercadoPago.getPaymentStatus(
            order.mercadoPagoPaymentId
          );
          console.log(`Status do pagamento ${order.id}: ${paymentStatus}`);

          if (
            currentTime.getTime() - orderCreationTime.getTime() >= 240000 &&
            order.remarketStage === 0
          ) {
            await this.firstRemarket(order.chatId);
            await this.prisma.order.update({
              where: { id: order.id },
              data: { remarketStage: 1 },
            });
            console.log(`Order ${order.id} processada após 4 minutos.`);
          }

          if (
            currentTime.getTime() - orderCreationTime.getTime() >= 3600000 &&
            order.remarketStage === 1
          ) {
            await this.sendLog({ log_type: "NOTEFETUED", order });
            await this.secondRemarket(order.chatId);
            await this.prisma.order.delete({ where: { id: order.id } });
            console.log(`Order ${order.id} expirou`);
          }

          if (paymentStatus === "approved") {
            await this.buyedGroup(order.chatId);
            await this.prisma.order.delete({ where: { id: order.id } });
            await this.sendLog({ order, log_type: "EFFETUED" });
            console.log(
              `Order ${order.id} concluída, mensagem enviada e excluída.`
            );
          }
        } catch (error) {
          console.log(`Order ${order.id}`);
        }
      }
    } catch (error) {
      console.error("Erro ao analisar orders:", error);
    }
  }

  async handleApprovedPayment(order) {
    try {
      // Envia uma mensagem ao usuário informando que o pagamento foi aprovado
      await this.bot.telegram.sendMessage(
        order.chatId,
        "✅ Seu pagamento foi aprovado! Obrigado por sua compra."
      );

      // Envia os links
      await this.bot.telegram.sendMessage(
        order.chatId,
        "VIP Adolescentes 👇\nhttps://t.me/+NvEVEfw0kuE4NmU5 \n\nBrinde 1 👇\nhttps://t.me/You_Sexybeach \n\nBrinde 2 👇\nhttps://t.me/+__MUqkeNEqA1NDk0 \n\nBrinde 3 👇\nhttps://t.me/joinchat/BHQ95nfIP6YwZDk6 \n\n"
      );
      // Exclui a ordem do banco de dados usando o Prisma
      await this.prisma.order.delete({ where: { id: order.id } });

      console.log(`Pedido ${order.id} concluído e excluído do banco de dados.`);
    } catch (error) {
      console.error("Erro ao lidar com pagamento aprovado:", error);
    }
  }
  async sendPendingPaymentNotification(chatId) {
    try {
      await this.bot.telegram.sendMessage(
        chatId,
        "⌛ Seu pagamento está pendente. Aguarde a aprovação."
      );
    } catch (error) {
      if (error.response && error.response.statusCode === 403) {
        this.sendLog({
          log_type: "USERBLOCK",
        });
      }
    }
  }
  // Method to send the second remarketing message
  async secondRemarket(chatId) {
    try {
      await this.bot.telegram.sendMessage(
        chat_id,
        "👋🏻 Olá, vimos que você gerou o Pagamento e ainda não concluiu a compra... Para demonstrar que queremos que você seja nosso assinante, abaixamos o valor para 𝗥$ 6,𝟵9 Caso você agora queira levar agora, te daremos: +𝟮 𝗚𝗿𝘂𝗽𝗼𝘀 𝗩𝗜𝗣𝗦 - +𝟭 𝗚𝗿𝘂𝗽𝗼 𝗣𝗮𝗿𝗮 𝗧𝗿𝗼𝗰𝗮𝘀 𝗱𝗲 𝗠𝗶́𝗱𝗶𝗮𝘀 𝗣𝗿𝗼𝗶𝗯𝗶𝗱𝗮𝘀 - + 𝟭𝟰𝗚𝗕 𝗱𝗲 𝗠𝗶́𝗱𝗶𝗮𝘀 𝗱𝗲 𝗣𝘂𝘁𝗮𝗿𝗶𝗮 𝗗𝟯𝟯𝗣𝗪𝗲𝗯.\n\n✅ Clique em: '𝐐𝐔𝐄𝐑𝐎 𝐀𝐃𝐐𝐔𝐈𝐑𝐈𝐑 🎉' E realize o Pagamento e Garanta acesso em nosso VIP."
      );
    } catch (error) {
      if (error.response && error.response.statusCode === 403) {
        this.sendLog({
          log_type: "USERBLOCK",
        });
      }
    }

    await this.bot.telegram
      .sendPhoto(
        chat_id,
        {
          source: fs.createReadStream(
            path.resolve("assets/images/remarket-banner.jpg")
          ),
        },
        Markup.inlineKeyboard([
          Markup.button.callback(
            "𝐐𝐔𝐄𝐑𝐎 𝐀𝐃𝐐𝐔𝐈𝐑𝐈𝐑 🎉",
            "generate_payment_discount"
          ),
        ])
      )
      .catch(function (error) {
        if (error.response && error.response.statusCode === 403) {
          this.sendLog({
            log_type: "USERBLOCK",
          });
        }
      });
  }

  // Method to send the first remarketing message
  async firstRemarket(chatId) {
    try {
      await this.bot.telegram.sendMessage(
        chat_id,
        "⛔️ 𝗦𝗲𝘂 𝗽𝗮𝗴𝗮𝗺𝗲𝗻𝘁𝗼 𝗮𝗶𝗻𝗱𝗮 𝗻𝗮̃𝗼 𝗳𝗼𝗶 𝗰𝗿𝗲𝗱𝗶𝘁𝗮𝗱𝗼 𝗲𝗺 𝗻𝗼𝘀𝘀𝗼 𝘀𝗶𝘀𝘁𝗲𝗺𝗮. O Pagamento para ser aprovado, demora em torno de 10 a 60 segundos 𝗮𝗽𝗼́𝘀 𝗮 𝗰𝗼𝗮𝗮𝗺𝗽𝗿𝗮 𝗳𝗲𝗶𝘁𝗮."
      );
    } catch (error) {
      if (error.response && error.response.statusCode === 403) {
        this.sendLog({
          log_type: "USERBLOCK",
        });
      }
    }
  }

  // Method to send message when the purchase is completed
  async buyedGroup(chat_id) {
    try {
      await this.bot.telegram.sendMessage(chat_id, "Esperamos que goste ❤");
    } catch (error) {
      if (error.response && error.response.statusCode === 403) {
        this.sendLog({
          log_type: "USERBLOCK",
        });
      }
    }

    try {
      await this.bot.telegram.sendMessage(
        chat_id,
        "VIP Adolescentes 👇\nhttps://t.me/+NvEVEfw0kuE4NmU5 \n\nBrinde 1 👇\nhttps://t.me/You_Sexybeach \n\nBrinde 2 👇\nhttps://t.me/+__MUqkeNEqA1NDk0 \n\nBrinde 3 👇\nhttps://t.me/joinchat/BHQ95nfIP6YwZDk6 \n\n"
      );
    } catch (error) {
      if (error.response && error.response.statusCode === 403) {
        this.sendLog({
          log_type: "USERBLOCK",
        });
      }
    }
  }

  // Method to send logs
  async sendLog(props) {
    const log_channel_id = process.env.LOG_CHANNEL_ID;

    const timestamp = moment().tz("America/Sao_Paulo").format("HH:mm:ss");

    let message = "";

    switch (props.log_type) {
      case "STARTBOT":
        if (props.userName || props.userUser) {
          message = `ＢＯＴ ＩＮＩＣＩＡＤＯ💥\nNome do lead: ${props.userName}\nUsuário: @${props.userUser}\nN* do cliente: ${this.index}\nHora (Brasília): ${timestamp}`;
        }
        break;

      case "EFFETUED":
        if (!props.order) return;
        message = `ＣＯＭＰＲＡ ＥＦＥＴＵＡＤＡ ✅\nNome do lead: ${props.order.buyerName}\nUsuário: @${props.order.buyerUser}\nN* do cliente: ${this.index}\nHora (Brasília): ${timestamp}`;
        break;

      case "NOTEFETUED":
        if (!props.order) return;
        message = `ＣＯＭＰＲＡ ＮＡ̃Ｏ ＥＦＥＴＵＡＤＡ ⛔️\nNome do lead: ${props.order.buyerName}\nUsuário: @${props.order.buyerUser}\nN* do cliente: ${this.index}\nHora (Brasília): ${timestamp}`;
        break;

      case "USERBLOCK":
        if (!props.order) return;
        message = `USUÁRIO BLOQUEOU O BOT ⛔️\nNome do lead: ${props.order.buyerName}\nUsuário: @${props.order.buyerUser}\nN* do cliente: ${this.index}\nHora (Brasília): ${timestamp}`;
        break;

      default:
        break;
    }

    if (message) {
      this.bot.telegram
        .sendMessage(log_channel_id.toString(), message)
        .catch(function (error) {
          if (error.response && error.response.statusCode === 403) {
            this.sendLog({
              log_type: "USERBLOCK",
            });
          }
        });
      this.index++;
    }
  }

  /**
   * Inicia o bot e o mantém ativo para receber comandos e ações.
   */
  start() {
    this.bot.launch(); // Inicia o bot
    console.log("Bot está ativo!");
  }
}
// Instancia o controlador do bot com o token do bot obtido das variáveis de ambiente e inicia o bot
const botController = new BotController(
  process.env.BOT_TOKEN || "YOUR_BOT_TOKEN"
);
botController.start();
