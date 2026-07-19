require("dotenv").config();
const dns = require("dns");

dns.setServers(["8.8.8.8", "8.8.4.4"]);
dns.setDefaultResultOrder("ipv4first");
const express = require("express");
const cors = require("cors");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(
  process.env.DB_PASSWORD,
)}@cluster0.xrup6i8.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

function generateTrackingId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const random = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `PAR-${date}-${random}`;
}

app.get("/", (req, res) => {
  res.send("Server is live!");
});

async function run() {
  try {
    await client.connect();

    const parcelsCollection = client.db("zap-shift-DB").collection("parcels");
    const paymentsCollection = client.db("zap-shift-DB").collection("payments");

    app.get("/parcels", async (req, res) => {
      const query = {};
      const email = req.query.email;
      if (email) {
        query.senderEmail = email;
      }
      const options = {
        sort: {
          creation_date: -1,
        },
      };
      0;
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:Id", async (req, res) => {
      const id = req.params.Id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              product_data: {
                name: paymentInfo.name,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          name: paymentInfo.name,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const trackingId = generateTrackingId();

      console.log(session);

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            isPaid: true,
            trackingId: trackingId,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.name,
          transationId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date().toISOString(),
        };

        console.log("Payment Object:", payment);

        if (session.payment_status === "paid") {
          const resultPayment = await paymentsCollection.insertOne(payment);
          return res.send({
            success: true,
            modifyParcel: result,
            paymentInfo: resultPayment,
            trackingId: trackingId,
            transationId: session.payment_intent,
          });
        }

        return res.send(result);
      }
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error(error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(` Server running on port ${port}`);
});
