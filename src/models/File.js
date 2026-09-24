import mongoose from "mongoose";
import { FILE_TYPES } from "../utils/fileType.js";

const fileSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    // Name as it arrived from the client, after sanitising.
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    // Name the object carries inside Drive (unique, timestamped).
    fileName: {
      type: String,
      required: true,
      trim: true,
    },

    mimeType: {
      type: String,
      required: true,
      trim: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 0,
    },
    fileType: {
      type: String,
      required: true,
      enum: FILE_TYPES,
      index: true,
    },

    driveFileId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    driveFolderId: {
      type: String,
      required: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// The dominant read pattern: active files of one type, newest first.
fileSchema.index({ isActive: 1, fileType: 1, createdAt: -1 });

// Optional text search over the free-text metadata.
fileSchema.index({ title: "text", description: "text", originalName: "text" });

fileSchema.methods.softDelete = function softDelete() {
  this.isActive = false;
  this.deletedAt = new Date();
  return this.save();
};

export const File = mongoose.model("File", fileSchema);
