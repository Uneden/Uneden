"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import AppImage from "@/components/ui/AppImage";
import { Upload, Trash2 } from "lucide-react";
import type { Area } from "react-easy-crop";
import ImageCropModal from "@/components/ui/ImageCropModal";
import getCroppedImg, { MAX_SOURCE_IMAGE_BYTES } from "@/utils/cropImage";
import { toast } from "sonner";

interface ImageUploaderProps {
  currentImage: string | null;
  onImageChange: (newImage: string) => void;
  label?: string;
  aspectRatio?: number;
}

export default function ImageUploader({
  currentImage,
  onImageChange,
  label,
  aspectRatio = 16 / 9,
}: ImageUploaderProps) {
  const { t } = useTranslation();
  const [showCropper, setShowCropper] = useState(false);
  const [imageToCrop, setImageToCrop] = useState<string | null>(null);
  const resolvedLabel = label ?? t('common.uploadImage');

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error(t('post.uploadImageTypeError'));
      return;
    }

    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      toast.error(t('post.uploadImageSizeError'));
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setImageToCrop(reader.result as string);
      setShowCropper(true);
    };
    reader.readAsDataURL(file);
  };

  const saveCroppedImage = async (croppedAreaPixels: Area) => {
    if (!imageToCrop) return;
    try {
      const croppedImage = await getCroppedImg(imageToCrop, croppedAreaPixels);
      onImageChange(croppedImage);
      setShowCropper(false);
      setImageToCrop(null);
    } catch {
      toast.error(t('post.cropImageError'));
    }
  };

  return (
    <>
      <div className="space-y-3">
        <input
          type="file"
          accept="image/*"
          id={`image-upload-${resolvedLabel}`}
          onChange={handleImageUpload}
          title={resolvedLabel}
          aria-label={resolvedLabel}
          className="hidden"
        />

        <Button
          type="button"
          variant="outline"
          className="w-full gap-2 cursor-pointer"
          onClick={() => document.getElementById(`image-upload-${resolvedLabel}`)?.click()}
        >
          <Upload className="h-4 w-4" />
          {resolvedLabel}
        </Button>

        {currentImage && (
        <div className="mt-3 relative aspect-video rounded-lg overflow-hidden border bg-gray-100">
          <AppImage
            src={currentImage}
            alt={t('common.preview')}
          fill
          sizes="100vw"
          className="object-cover"
            />

            <button
            type="button"
            onClick={() => onImageChange("")}
            title={t('common.remove')}
            aria-label={t('common.remove')}
            className="cursor-pointer absolute top-2 right-2 bg-red-600 text-white p-2 rounded-full shadow hover:bg-red-700 transition"
            >
            <Trash2 className="w-4 h-4" />
            </button>
        </div>
        )}
      </div>

      {showCropper && imageToCrop && (
        <ImageCropModal
          image={imageToCrop}
          aspect={aspectRatio}
          title={t('post.adjustImage')}
          onCancel={() => {
            setShowCropper(false);
            setImageToCrop(null);
          }}
          onSave={saveCroppedImage}
        />
      )}
    </>
  );
}