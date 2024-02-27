const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const { PrismaClient } = require("@prisma/client");

class MercadoPagoAPI {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.tempDir = os.tmpdir();
    this.prisma = new PrismaClient();
    this.fsPromises = fs;
  }

  async createPayment(ctx, amount, email, name, cpf, userId) {
    try {
      const expireDate = this.getExpireDate(30);
      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount)) throw new Error("Quantia inválida.");
      const idempotencyKey = uuidv4();

      const response = await axios.post(
        "https://api.mercadopago.com/v1/payments",
        {
          transaction_amount: numericAmount,
          description: "Pagamento",
          payment_method_id: "pix",
          payer: {
            email,
            identification: { type: "cpf", number: cpf },
          },
          date_of_expiration: expireDate,
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "X-Idempotency-Key": idempotencyKey,
          },
        }
      );
      if (
        !response.data ||
        !response.data.point_of_interaction ||
        !response.data.point_of_interaction.transaction_data
      ) {
        throw new Error("Resposta inválida da API do MercadoPago.");
      }
      console.log("Resposta da criação do pagamento:", response.data);
      const order = await this.saveOrderDetails(
        response,
        userId ? userId.toString() : "",
        name,
        ctx
      );
      await this.handleQRCode(ctx, response, idempotencyKey);
      return order;
    } catch (error) {
      console.error(
        "Erro ao criar pagamento:",
        error.response ? error.response.data : error.message
      );
      throw error;
    }
  }
  async ensureDirectoryExists(directory) {
    try {
      await this.fsPromises.access(directory);
    } catch (error) {
      if (error.code === "ENOENT") {
        // Se o diretório não existe, tenta criar
        try {
          await this.fsPromises.mkdir(directory, { recursive: true });
        } catch (createError) {
          console.error(`Erro ao criar o diretório ${directory}:`, createError);
          throw createError;
        }
      } else {
        // Outro tipo de erro ao acessar o diretório
        console.error(`Erro ao acessar o diretório ${directory}:`, error);
        throw error;
      }
    }
  }
  async handleQRCode(ctx, response, idempotencyKey) {
    const paymentData = response.data;
    if (
      !paymentData ||
      !paymentData.point_of_interaction ||
      !paymentData.point_of_interaction.transaction_data
    ) {
      throw new Error("Dados de pagamento inválidos ou ausentes.");
    }
    const pixData = paymentData.point_of_interaction.transaction_data;
    const qrCodeBase64 = pixData.qr_code_base64;

    if (!qrCodeBase64) {
      throw new Error("O código QR não está disponível.");
    }
    // Prepare PIX text
    let pixText = `🅾️ Pagamento foi 𝗴𝗲𝗿𝗮𝗱𝗼, você tem: 𝟲 𝗠𝗶𝗻𝘂𝘁𝗼𝘀 para concluir o PIX.\n\n✅ 𝗖𝗹𝗶𝗾𝘂𝗲 𝗻𝗼 𝗣𝗜𝗫 𝗖𝗼𝗽𝗶𝗮 & 𝗖𝗼𝗹𝗮 𝗔𝗯𝗮𝗶𝘅𝗼 𝗽𝗮𝗿𝗮 𝗰𝗼𝗽𝗶𝗮𝗿 ⬇️ 𝗘 𝗿𝗲𝗮𝗹𝗶𝘇𝗲 𝗮 𝘀𝘂𝗮 𝗰𝗼𝗺𝗽𝗿𝗮 𝗰𝗼𝗺 𝘂́𝗻𝗶𝗰𝗼 𝗱𝗲 7𝟬% ❗️`;

    try {
      const qrCodeBuffer = Buffer.from(qrCodeBase64, "base64");
      const tempDirPath = path.join(this.tempDir, idempotencyKey);
      await this.ensureDirectoryExists(tempDirPath);
      const imagePath = path.join(tempDirPath, "qrcode.png");
      await fs.writeFile(imagePath, qrCodeBuffer);
      console.log(`QR Code salvo em: ${imagePath}`);

      // Escape Markdown characters in PIX text
      function escapeMarkdownV2(text) {
        const escapeChars = "_*[]()~`>#+-=|{}.!";
        return text
          .split("")
          .map((char) => (escapeChars.includes(char) ? "\\" + char : char))
          .join("");
      }

      // Send PIX text with QR Code image
      const escapedPixText = escapeMarkdownV2(pixText);
      await ctx.replyWithPhoto(
        { source: imagePath },
        { caption: escapedPixText, parse_mode: "MarkdownV2" }
      );

      // Escape Markdown characters in PIX Code and send it as a message
      const escapedPixCode = escapeMarkdownV2(pixData.qr_code);
      await ctx.reply(
        `Copia e Cola:\n\`\`\`md\n${
          escapedPixCode || "Código QR não disponível"
        }\n\`\`\``,
        { parse_mode: "MarkdownV2" }
      );
    } catch (err) {
      // Log and throw error if directory creation or image saving fails
      console.error(
        "Erro ao criar diretório de destino ou salvar imagem:",
        err
      );
      throw err;
    }
  }

  async saveBase64Image(base64String, imagePath) {
    try {
      const data = base64String.replace(/^image\/\w+;base64,/, "");
      const buffer = Buffer.from(data, "base64");

      // Verificar se o buffer está vazio antes de gravar a imagem
      if (buffer.length === 0) {
        throw new Error("O buffer da imagem do QR Code está vazio.");
      }

      await fs.promises.writeFile(imagePath, buffer);
    } catch (error) {
      console.error("Erro ao criar a imagem do QR Code:", error.message);
      throw error;
    }
  }
  async saveOrderDetails(ctx, response, email, name, cpf, userId) {
    try {
      const paymentData = response.data;
      const pixData = paymentData.point_of_interaction.transaction_data;

      // Salva os detalhes do pedido no banco de dados
      const order = await this.prisma.order.create({
        data: {
          txId: paymentData.id.toString(), // Convert the paymentData.id to a string
          chatId: parseInt(userId, 10),
          buyerName: name,  // Corrigir erro - Usar buyerName ao invés de name
          status: "pending", // Defina o status inicial como pendente
          remarketStage: 0,
          createdAt: new Date(),
        },
      });

      // Envia uma mensagem com os detalhes do pedido e o código QR
      await this.handleQRCode(ctx, response, order.txId);

      return order;
    } catch (error) {
      console.error("Erro ao salvar os detalhes do pedido:", error);
      throw error;
    }
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

  getExpireDate(minutes) {
    const date = new Date();
    date.setMinutes(date.getMinutes() + minutes);
    return date.toISOString();
  }
}

module.exports = MercadoPagoAPI;
