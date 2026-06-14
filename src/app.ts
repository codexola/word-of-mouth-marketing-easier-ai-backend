import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { isAllowedFrontendOrigin } from "./lib/frontend-origin.js";import { ensureUploadsDir, UPLOADS_DIR } from "./lib/uploads.js";
import { errorHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/auth.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import postsRoutes from "./routes/posts.routes.js";
import driveRoutes from "./routes/drive.routes.js";
import lineRoutes from "./routes/line.routes.js";
import reviewsRoutes from "./routes/reviews.routes.js";
import gbpRoutes from "./routes/gbp.routes.js";
import gmailRoutes from "./routes/gmail.routes.js";
import mediaRoutes from "./routes/media.routes.js";
import usersRoutes from "./routes/users.routes.js";

export function createApp() {
  const app = express();
  ensureUploadsDir();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || isAllowedFrontendOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`CORS blocked: ${origin}`));
      },
      credentials: true,
    })
  );  app.use("/uploads", express.static(UPLOADS_DIR));

  app.use("/api/line", lineRoutes);

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/users", usersRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/posts", postsRoutes);
  app.use("/api/drive", driveRoutes);
  app.use("/api/reviews", reviewsRoutes);
  app.use("/api/gbp", gbpRoutes);
  app.use("/api/gmail", gmailRoutes);
  app.use("/api/media", mediaRoutes);

  app.use(errorHandler);

  return app;
}
