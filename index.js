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

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
});

app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  console.log(token);

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await getAuth(firebaseApp).verifyIdToken(idToken);
    console.log("decoded", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.error(error);

    if (error.code === "auth/id-token-expired") {
      return res.status(401).send({ message: "token expired" });
    }

    return res.status(401).send({ message: "unauthorized access" });
  }
};

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
    const usersCollection = client.db("zap-shift-DB").collection("users");
    const ridersCollection = client.db("zap-shift-DB").collection("riders");

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
      const transationId = session.payment_intent;

      const query = {
        transationId: transationId,
      };

      const paymentExist = await paymentsCollection.findOne(query);

      if (paymentExist) {
        return res.send({
          success: true,
          message: "Already Exists",
          transationId,
          trackingId: paymentExist.trackingId,
        });
      }

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
          trackingId: trackingId,
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

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const cursor = paymentsCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();

      res.send(result);
    });

    // rider related apis
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.created_at = new Date().toISOString();
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/riders/:riderId", verifyFBToken, async (req, res) => {
      const id = req.params.riderId;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
        },
      };
      const result = await ridersCollection.updateOne(query, updateDoc);

      if (status === "accepted") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        await usersCollection.updateOne(userQuery, updateUser);
      }

      res.send(result);
    });

    app.delete("/riders/:riderId", async (req, res) => {
      const id = req.params.riderId;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);
      res.send(result);
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

    // user related apis

    app.post("/users", verifyFBToken, async (req, res) => {
      const user = req.body;
      user.role = "user";
      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res.send({ message: "User already exists." });
      }
      const result = await usersCollection.insertOne(user);
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
