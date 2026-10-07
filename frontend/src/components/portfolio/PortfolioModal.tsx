"use client";

import { useState } from "react";
import { useScrollLock } from "@/hooks/useScrollLock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import AppImage from "@/components/ui/AppImage";
import type { Area } from "react-easy-crop";
import ImageCropModal from "@/components/ui/ImageCropModal";
import getCroppedImg from "@/utils/cropImage";
import { uploadUserImage } from "@/lib/listingImages";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface PortfolioModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (item: { image: string; title: string; description: string }) => void;
}

export default function PortfolioModal({ open, onClose, onSave }: PortfolioModalProps) {
  const { t } = useTranslation();
  useScrollLock(open);
  const [image, setImage] = useState<string | null>(null);
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [showCropper, setShowCropper] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState(false);

  if (!open) return null;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setRawImage(reader.result as string);
      setShowCropper(true);
    };
    reader.readAsDataURL(file);
  };

  const confirmCrop = async (croppedAreaPixels: Area) => {
    if (!rawImage) return;
    try {
      const cropped = await getCroppedImg(rawImage, croppedAreaPixels);
      setImage(await uploadUserImage(cropped, "portfolio"));
      setShowCropper(false);
      setRawImage(null);
    } catch {
      toast.error(t("profile.uploadError"));
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !image) {
      setError(true);
      return;
    }

    onSave({ image, title, description });

    setImage(null);
    setRawImage(null);
    setTitle("");
    setDescription("");
    setError(false);
    setShowCropper(false);

    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <h2 className="text-xl font-semibold mb-4">{t("portfolioModal.title")}</h2>

          {!image ? (
            <label className="w-full h-40 border-2 border-dashed border-gray-300 rounded-xl flex items-center justify-center cursor-pointer hover:bg-gray-50 mb-4">
              <span className="text-gray-600">{t("portfolioModal.clickToUpload")}</span>
              <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            </label>
          ) : (
            <div className="relative mb-4">
              <div className="w-full aspect-4/3 rounded-xl overflow-hidden bg-gray-100">
                <AppImage src={image} alt={t("portfolioModal.previewAlt")} fill sizes="100vw" className="object-cover" />
              </div>
              <label className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-xl cursor-pointer opacity-0 hover:opacity-100 transition-opacity">
                <span className="text-white text-sm font-medium">{t("portfolioModal.changeImage")}</span>
                <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
              </label>
            </div>
          )}

          <div className="space-y-2 mb-4">
            <Label>{t("portfolioModal.titleLabel")} *</Label>
            <Input
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (error) setError(false); }}
              placeholder={t("portfolioModal.titlePlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            {error && <p className="text-red-500 text-sm">{t("portfolioModal.titleRequired")}</p>}
          </div>

          <div className="space-y-2 mb-6">
            <Label>{t("portfolioModal.descriptionLabel")}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("portfolioModal.descriptionPlaceholder")} />
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 cursor-pointer" onClick={onClose}>{t("common.cancel")}</Button>
            <Button className="flex-1 bg-green-700 hover:bg-green-800 text-white cursor-pointer" onClick={handleSave}>
              {t("portfolioModal.addButton")}
            </Button>
          </div>
        </div>
      </div>

      {showCropper && rawImage && (
        <ImageCropModal
          image={rawImage}
          aspect={4 / 3}
          title={t("portfolioModal.adjustImage")}
          saveLabel={t("portfolioModal.confirmButton")}
          onCancel={() => {
            setShowCropper(false);
            setRawImage(null);
          }}
          onSave={confirmCrop}
        />
      )}
    </>
  );
}
