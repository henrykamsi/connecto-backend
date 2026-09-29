const express = require("express");
const crypto = require("crypto");

const { authenticate } = require("../middleware/auth");
const { createUploadUrl } = require("../providers/b2");

const router = express.Router();

router.post("/upload-url", authenticate, async (req, res, next) => {
  try {
    const contentType = String(req.body.content_type || "");

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm"
    ];

    if (!allowed.includes(contentType)) {
      return res.status(422).json({
        success: false,
        error: "UNSUPPORTED_MEDIA_TYPE"
      });
    }

    const extension = contentType.split("/")[1];

    const key =
      `users/${req.user.id}/uploads/` +
      `${crypto.randomUUID()}.${extension}`;

    const uploadUrl = await createUploadUrl(key, contentType);

    res.json({
      success: true,
      media: {
        key,
        content_type: contentType,
        upload_url: uploadUrl
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
