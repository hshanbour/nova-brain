import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "Nova Brain",
    status: "online"
  });
});

app.post("/api/missed-call", (req, res) => {
  const { phone, name } = req.body;

  res.json({
    success: true,
    message: "Missed call received",
    lead: {
      name: name || "Unknown",
      phone: phone || null
    }
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Nova Brain running on port ${PORT}`);
});
