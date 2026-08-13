require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
dns.setDefaultResultOrder("ipv4first");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);
const firebaseApp = initializeApp({ credential: cert(serviceAccount) });

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@cluster0.xrup6i8.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// --- Serverless-safe connection caching ---
// Reuses the same client across warm invocations instead of reconnecting every cold start.
let cachedClient = null;
async function getDb() {
  if (cachedClient) return cachedClient.db("zap-shift-DB");
  const client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await client.connect();
  cachedClient = client;
  console.log("✅ MongoDB connected");
  return client.db("zap-shift-DB");
}

// Middleware: guarantees the DB is ready before ANY route handler runs,
// and makes collections available on req instead of relying on closures.
app.use(async (req, res, next) => {
  try {
    const db = await getDb();
    req.parcelsCollection = db.collection("parcels");
    req.paymentsCollection = db.collection("payments");
    req.usersCollection = db.collection("users");
    req.ridersCollection = db.collection("riders");
    req.trackingsCollection = db.collection("trackings");
    next();
  } catch (error) {
    console.error("DB connection error:", error);
    res.status(500).send({ message: "Database connection failed" });
  }
});

function generateTrackingId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `PAR-${date}-${random}`;
}

const logTracking = async (trackingsCollection, trackingId, status) => {
  const log = {
    trackingId,
    status,
    details: status.split("_").join(" "),
    createdAt: new Date(),
  };
  return trackingsCollection.insertOne(log);
};

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: "unauthorized access" });
  try {
    const idToken = token.split(" ")[1];
    const decoded = await getAuth(firebaseApp).verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    if (error.code === "auth/id-token-expired") {
      return res.status(401).send({ message: "token expired" });
    }
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const verifyAdmin = async (req, res, next) => {
  const user = await req.usersCollection.findOne({ email: req.decoded_email });
  if (!user || user.role !== "admin") {
    return res
      .status(403)
      .send({ message: "You Are Forbidden to Access This Page" });
  }
  next();
};

const verifyRider = async (req, res, next) => {
  const user = await req.usersCollection.findOne({ email: req.decoded_email });
  if (!user || user.role !== "rider") {
    return res
      .status(403)
      .send({ message: "You Are Forbidden to Access This Page" });
  }
  next();
};

// --- Routes: registered immediately, synchronously, at module load ---

app.get("/", (req, res) => {
  res.send("Server is live!");
});

app.get("/parcels", async (req, res) => {
  const { email, deliveryStatus } = req.query;
  const query = {};
  if (email) query.senderEmail = email;
  if (deliveryStatus) query.deliveryStatus = deliveryStatus;
  const result = await req.parcelsCollection
    .find(query)
    .sort({ creation_date: -1 })
    .toArray();
  res.send(result);
});

app.get("/parcels/rider", async (req, res) => {
  const { riderEmail, deliveryStatus } = req.query;
  const query = {};
  if (riderEmail) query.riderEmail = riderEmail;
  if (deliveryStatus) query.deliveryStatus = { $in: deliveryStatus.split(",") };
  const result = await req.parcelsCollection.find(query).toArray();
  res.send(result);
});

app.get(
  "/parcels/deliver-status/stats",
  verifyFBToken,
  verifyAdmin,
  async (req, res) => {
    const pipeline = [
      { $group: { _id: "$deliveryStatus", count: { $sum: 1 } } },
    ];
    const result = await req.parcelsCollection.aggregate(pipeline).toArray();
    res.send(result);
  },
);

app.get("/parcels/stats", verifyFBToken, async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).send({ message: "email is required" });
    if (email !== req.decoded_email)
      return res.status(403).send({ message: "forbidden access" });

    const statusBreakdown = await req.parcelsCollection
      .aggregate([
        { $match: { senderEmail: email } },
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
            totalCost: { $sum: { $toDouble: "$cost" } },
          },
        },
      ])
      .toArray();

    const summaryResult = await req.parcelsCollection
      .aggregate([
        { $match: { senderEmail: email } },
        {
          $group: {
            _id: null,
            totalParcels: { $sum: 1 },
            totalCost: { $sum: { $toDouble: "$cost" } },
            totalPaid: { $sum: { $cond: [{ $eq: ["$isPaid", true] }, 1, 0] } },
            totalUnpaid: {
              $sum: { $cond: [{ $eq: ["$isPaid", true] }, 0, 1] },
            },
          },
        },
      ])
      .toArray();

    const summary = summaryResult[0] ?? {
      totalParcels: 0,
      totalCost: 0,
      totalPaid: 0,
      totalUnpaid: 0,
    };
    res.send({ summary, statusBreakdown });
  } catch (error) {
    console.error("Error fetching user parcel stats:", error);
    res.status(500).send({ message: "Failed to load parcel stats" });
  }
});

app.get("/parcels/:Id", async (req, res) => {
  try {
    const result = await req.parcelsCollection.findOne({
      _id: new ObjectId(req.params.Id),
    });
    res.send(result);
  } catch (error) {
    res.status(400).send({ message: "Invalid parcel id" });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  const paymentInfo = req.body;
  const amount = parseInt(paymentInfo.cost) * 100;
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "USD",
          product_data: { name: paymentInfo.name },
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
      trackingId: paymentInfo.trackingId,
    },
    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
  });
  res.send({ url: session.url });
});

app.patch("/payment-success", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(
      req.query.session_id,
    );
    const transationId = session.payment_intent;
    const paymentExist = await req.paymentsCollection.findOne({ transationId });

    if (paymentExist) {
      return res.send({
        success: true,
        message: "Already Exists",
        transationId,
        trackingId: paymentExist.trackingId,
      });
    }

    if (session.payment_status === "paid") {
      const trackingId = session.metadata.trackingId;
      const id = session.metadata.parcelId;
      const result = await req.parcelsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { isPaid: true, deliveryStatus: "pending_pickup", trackingId },
        },
      );

      const payment = {
        amount: session.amount_total / 100,
        currency: session.currency,
        customerEmail: session.customer_email,
        parcelId: session.metadata.parcelId,
        parcelName: session.metadata.name,
        transationId: session.payment_intent,
        trackingId,
        paymentStatus: session.payment_status,
        paidAt: new Date().toISOString(),
      };

      const resultPayment = await req.paymentsCollection.insertOne(payment);
      await logTracking(req.trackingsCollection, trackingId, "pending_pickup");

      return res.send({
        success: true,
        modifyParcel: result,
        paymentInfo: resultPayment,
        trackingId,
        transationId: session.payment_intent,
      });
    }

    return res
      .status(400)
      .send({ success: false, message: "Payment not completed" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to process payment" });
  }
});

app.get("/payments", verifyFBToken, async (req, res) => {
  const email = req.query.email;
  const query = {};
  if (email) {
    query.customerEmail = email;
    if (email !== req.decoded_email)
      return res.status(403).send({ message: "forbidden access" });
  }
  const result = await req.paymentsCollection
    .find(query)
    .sort({ paidAt: -1 })
    .toArray();
  res.send(result);
});

app.post("/riders", async (req, res) => {
  const rider = req.body;
  rider.status = "pending";
  rider.created_at = new Date().toISOString();
  const result = await req.ridersCollection.insertOne(rider);
  res.send(result);
});

app.get("/riders", async (req, res) => {
  const { status, district, workStatus } = req.query;
  const query = {};
  if (status) query.status = status;
  if (district) query.riderDistrict = district;
  if (workStatus) query.workStatus = workStatus;
  const result = await req.ridersCollection.find(query).toArray();
  res.send(result);
});

app.get("/riders/stats", verifyFBToken, verifyRider, async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).send({ message: "email is required" });
    if (email !== req.decoded_email)
      return res.status(403).send({ message: "forbidden access" });

    const statusBreakdown = await req.parcelsCollection
      .aggregate([
        { $match: { riderEmail: email } },
        { $group: { _id: "$deliveryStatus", count: { $sum: 1 } } },
      ])
      .toArray();

    const payoutResult = await req.parcelsCollection
      .aggregate([
        { $match: { riderEmail: email, deliveryStatus: "delivered" } },
        {
          $project: {
            cost: { $toDouble: "$cost" },
            sameDistrict: { $eq: ["$senderDistrict", "$receiverDistrict"] },
          },
        },
        {
          $project: {
            payout: {
              $cond: [
                "$sameDistrict",
                { $multiply: ["$cost", 0.8] },
                { $multiply: ["$cost", 0.6] },
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            totalDelivered: { $sum: 1 },
            totalEarnings: { $sum: "$payout" },
          },
        },
      ])
      .toArray();

    const earnings = payoutResult[0] ?? { totalDelivered: 0, totalEarnings: 0 };
    const totalAssigned = statusBreakdown.reduce((sum, s) => sum + s.count, 0);

    res.send({
      totalAssigned,
      totalDelivered: earnings.totalDelivered,
      totalEarnings: earnings.totalEarnings,
      statusBreakdown,
    });
  } catch (error) {
    console.error("Error fetching rider stats:", error);
    res.status(500).send({ message: "Failed to load rider stats" });
  }
});

app.patch("/riders/:riderId", verifyFBToken, async (req, res) => {
  const status = req.body.status;
  const result = await req.ridersCollection.updateOne(
    { _id: new ObjectId(req.params.riderId) },
    { $set: { status, workStatus: "available" } },
  );
  if (status === "accepted") {
    await req.usersCollection.updateOne(
      { email: req.body.email },
      { $set: { role: "rider" } },
    );
  }
  res.send(result);
});

app.get(
  "/riders/status/stats",
  verifyFBToken,
  verifyAdmin,
  async (req, res) => {
    const result = await req.ridersCollection
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();
    res.send(result);
  },
);

app.get(
  "/riders/work-status/stats",
  verifyFBToken,
  verifyAdmin,
  async (req, res) => {
    const result = await req.ridersCollection
      .aggregate([{ $group: { _id: "$workStatus", count: { $sum: 1 } } }])
      .toArray();
    res.send(result);
  },
);

app.delete("/riders/:riderId", async (req, res) => {
  const result = await req.ridersCollection.deleteOne({
    _id: new ObjectId(req.params.riderId),
  });
  res.send(result);
});

app.get("/trackings/:trackingId/logs", async (req, res) => {
  const result = await req.trackingsCollection
    .find({ trackingId: req.params.trackingId })
    .sort({ createdAt: 1 })
    .toArray();
  res.send(result);
});

app.post("/parcels", async (req, res) => {
  const parcel = req.body;
  const trackingId = generateTrackingId();
  parcel.trackingId = trackingId;
  await logTracking(req.trackingsCollection, trackingId, "parcel_created");
  const result = await req.parcelsCollection.insertOne(parcel);
  res.send(result);
});

app.delete("/parcels/:id", async (req, res) => {
  const result = await req.parcelsCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });
  res.send(result);
});

app.patch("/parcels/:id/status", async (req, res) => {
  try {
    const { deliveryStatus, riderId, trackingId } = req.body;
    const result = await req.parcelsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { deliveryStatus } },
    );

    if (deliveryStatus === "delivered" && riderId) {
      await req.ridersCollection.updateOne(
        { _id: new ObjectId(riderId) },
        { $set: { workStatus: "available" } },
      );
    }

    await logTracking(req.trackingsCollection, trackingId, deliveryStatus);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update status" });
  }
});

app.patch("/parcels/:id", async (req, res) => {
  try {
    const { riderName, riderEmail, riderId, trackingId, deliveryStatus } =
      req.body;
    const result = await req.parcelsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { deliveryStatus, riderId, riderEmail, riderName } },
    );
    const riderResult = await req.ridersCollection.updateOne(
      { _id: new ObjectId(riderId) },
      { $set: { workStatus: "in_delivery" } },
    );
    await logTracking(req.trackingsCollection, trackingId, deliveryStatus);
    res.send({
      parcelModifiedCount: result.modifiedCount,
      riderModifiedCount: riderResult.modifiedCount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to assign rider" });
  }
});

app.post("/users", verifyFBToken, async (req, res) => {
  const user = req.body;
  user.role = "user";
  const userExists = await req.usersCollection.findOne({ email: user.email });
  if (userExists) return res.send({ message: "User already exists." });
  const result = await req.usersCollection.insertOne(user);
  res.send(result);
});

app.get("/users", verifyFBToken, async (req, res) => {
  const result = await req.usersCollection.find().toArray();
  res.send(result);
});

app.get("/users/:email/role", async (req, res) => {
  const user = await req.usersCollection.findOne({ email: req.params.email });
  res.send({ role: user?.role || "user" });
});

app.patch(
  "/users/:userId/role",
  verifyFBToken,
  verifyAdmin,
  async (req, res) => {
    const result = await req.usersCollection.updateOne(
      { _id: new ObjectId(req.params.userId) },
      { $set: { role: req.body.role } },
    );
    res.send(result);
  },
);

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
