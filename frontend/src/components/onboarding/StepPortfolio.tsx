"use client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, ImageIcon } from "lucide-react";
import AppImage from "@/components/ui/AppImage";
import type { Area } from "react-easy-crop";
import ImageCropModal from "@/components/ui/ImageCropModal";
import getCroppedImg from "@/utils/cropImage";
import { uploadUserImage } from "@/lib/listingImages";
import { PortfolioItem } from "./onboardingTypes";
import { toast } from "sonner";

interface Props {
  portfolio: PortfolioItem[];
  accountType: "person" | "company";
  onAdd: (item: PortfolioItem) => void;
  onRemove: (id: number) => void;
  onUpdate: (id: number, field: keyof PortfolioItem, value: string) => void;
}

export default function StepPortfolio({ portfolio, accountType, onAdd, onRemove, onUpdate }: Props) {
  const { t } = useTranslation();
  const isCompany = accountType === "company";
  const [showCropper, setShowCropper] = useState(false);
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState(false);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast.error(t('onboarding.invalidImageFile')); return; }
    const reader = new FileReader();
    reader.onloadend = () => {
      setRawImage(reader.result as string);
      setTitle("");
      setError(false);
      setShowCropper(true);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (croppedPixels: Area) => {
    if (!rawImage || !title.trim()) {
      setError(true);
      return;
    }
    try {
      const cropped = await getCroppedImg(rawImage, croppedPixels);
      const image = await uploadUserImage(cropped, "portfolio");
      onAdd({ id: portfolio.length + 1, image, title: title.trim(), description: "" });
      closeModal();
    } catch {
      toast.error(t('onboarding.cropImageFailed'));
    }
  };

  const closeModal = () => {
    setShowCropper(false);
    setRawImage(null);
    setTitle("");
    setError(false);
  };

  return (
    <>
      <Card className="p-6 sm:p-8 animate-in fade-in duration-300">
        <h2 className="text-xl font-bold text-gray-900">{isCompany ? t("onboarding.companyProjectsTitle") : t("onboarding.portfolio")}</h2>
        <p className="text-gray-600">{isCompany ? t("onboarding.companyProjectsSubtitle") : t("onboarding.portfolioSubtitle")}</p>

        <div className="space-y-6">
          {portfolio.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-4">
              {portfolio.map((item) => (
                <div key={item.id} className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="relative aspect-4/3 bg-gray-100">
                    <AppImage src={item.image} alt={item.title || t('onboarding.portfolioItemAlt')} fill sizes="(max-width: 640px) 100vw, 50vw" className="object-cover" />
                    <button
                      type="button"
                      title={t('onboarding.removePortfolioItem')}
                      aria-label={t('onboarding.removePortfolioItem')}
                      onClick={() => onRemove(item.id)}
                      className="cursor-pointer absolute top-2 right-2 p-2 bg-red-500 text-white rounded-full hover:bg-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="p-4">
                    <Input
                      placeholder={t("onboarding.photoTitle")}
                      value={item.title}
                      onChange={(e) => onUpdate(item.id, "title", e.target.value)}
                      className="h-10"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {portfolio.length === 0 && (
            <div className="text-center py-8 border-2 border-dashed border-gray-200 rounded-xl">
              <ImageIcon className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 mb-4">{isCompany ? t('onboarding.noProjects') : t('onboarding.noPortfolio')}</p>
            </div>
          )}

          <Button variant="outline" onClick={() => document.getElementById("portfolioInput")?.click()} className="w-full gap-2 cursor-pointer">
            <Plus className="h-4 w-4" /> {t("onboarding.addPhoto")}
          </Button>
          <input type="file" accept="image/*" id="portfolioInput" title={isCompany ? t('onboarding.uploadProjectImage') : t('onboarding.uploadPortfolioImage')} aria-label={isCompany ? t('onboarding.uploadProjectImage') : t('onboarding.uploadPortfolioImage')} className="hidden" onChange={handleUpload} />
        </div>
      </Card>

      {showCropper && rawImage && (
        <ImageCropModal
          image={rawImage}
          aspect={4 / 3}
          title={t("post.adjustImage")}
          saveLabel={t("onboarding.addPhoto")}
          onCancel={closeModal}
          onSave={handleSave}
          footer={
            <div>
              <Input
                type="text"
                placeholder={t("onboarding.photoTitle")}
                value={title}
                onChange={(e) => { setTitle(e.target.value); setError(false); }}
                className={error ? "border-red-500" : ""}
              />
              {error && <p className="text-xs text-red-500 mt-1">{t('onboarding.titleRequired')}</p>}
            </div>
          }
        />
      )}
    </>
  );
}
