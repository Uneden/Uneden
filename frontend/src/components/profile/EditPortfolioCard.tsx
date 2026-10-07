"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import AppImage from "@/components/ui/AppImage";
import { Trash2, Plus, Pencil } from "lucide-react";
import type { Area } from "react-easy-crop";
import ImageCropModal from "@/components/ui/ImageCropModal";
import getCroppedImg from "@/utils/cropImage";
import { uploadUserImage } from "@/lib/listingImages";
import { toast } from "sonner";
import { useScrollLock } from "@/hooks/useScrollLock";
import { useTranslation } from "react-i18next";

interface PortfolioItem {
  id: number;
  image: string;
  title: string;
}

interface Props {
  portfolio: PortfolioItem[];
  isPerson: boolean;
  onAdd: (item: PortfolioItem) => void;
  onUpdate: (item: PortfolioItem) => void;
  onRemove: (id: number) => void;
}

export default function EditPortfolioCard({ portfolio, isPerson, onAdd, onUpdate, onRemove }: Props) {
  const { t } = useTranslation();
  const sectionTitle = isPerson ? t("profile.portfolio") : t("profile.ourWork");
  const sectionSubtitle = isPerson ? t("profile.uploadPortfolio") : t("profile.uploadProjects");
  const addItemLabel = isPerson ? t("profile.addPortfolioItem", "Ajouter un élément au portfolio") : t("profile.addProjectItem");
  const titlePlaceholder = isPerson ? t("profile.portfolioTitlePlaceholder") : t("profile.projectTitlePlaceholder");
  const addButtonLabel = isPerson ? t("profile.addToPortfolio") : t("profile.addToProjects");
  const [showModal, setShowModal] = useState(false);
  const [showActionModal, setShowActionModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PortfolioItem | null>(null);
  const [image, setImage] = useState<string | null>(null);
  useScrollLock(showActionModal);
  const [title, setTitle] = useState("");
  const [error, setError] = useState(false);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast.error(t("profile.invalidImageFile")); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error(t("profile.maxFileSize")); return; }
    const reader = new FileReader();
    reader.onloadend = () => {
      setSelectedItem(null);
      setImage(reader.result as string);
      setTitle("");
      setShowModal(true);
    };
    reader.readAsDataURL(file);
  };

  const handleCropSave = async (croppedAreaPixels: Area) => {
    if (!image || !title.trim()) { setError(true); return; }
    try {
      const nextImage = await uploadUserImage(await getCroppedImg(image, croppedAreaPixels), "portfolio");
      if (selectedItem) {
        onUpdate({ ...selectedItem, image: nextImage, title: title.trim() });
      } else {
        const newId = portfolio.length > 0 ? Math.max(...portfolio.map((p) => p.id)) + 1 : 1;
        onAdd({ id: newId, image: nextImage, title: title.trim() });
      }
      closeModal();
    } catch {
      toast.error(t("profile.cropImageFailed"));
    }
  };

  const handleEditItem = (item: PortfolioItem) => {
    setSelectedItem(item);
    setImage(item.image);
    setTitle(item.title);
    setError(false);
    setShowActionModal(false);
    setShowModal(true);
  };

  const openMobileActions = (item: PortfolioItem) => {
    setSelectedItem(item);
    setShowActionModal(true);
  };

  const closeActionModal = () => {
    setShowActionModal(false);
    setSelectedItem(null);
  };

  const closeModal = () => {
    setShowModal(false);
    setSelectedItem(null);
    setImage(null);
    setTitle("");
    setError(false);
  };

  const portfolioTips = [
    t("profile.tipQuality"),
    t("profile.tipVariety"),
    t("profile.tipBright"),
  ];

  return (
    <>
      <div className="mb-6 border-2 border-green-700 rounded-2xl overflow-hidden bg-white grid grid-cols-1 lg:grid-cols-2">
        {/* Left panel — style page contact */}
        <div className="bg-green-800 px-8 py-10 sm:px-10 sm:py-12 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-green-700">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white leading-tight mb-3">
              {sectionTitle}
            </h2>
            <p className="text-green-200 text-sm mb-10 leading-relaxed">
              {sectionSubtitle}
            </p>

            <div className="space-y-6">
              <p className="text-white font-semibold text-sm">{t("profile.tipTitle")}</p>
              {portfolioTips.map((tip) => (
                <div key={tip} className="flex items-start gap-4">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-300 shrink-0 mt-1.5" />
                  <p className="text-green-200 text-xs leading-relaxed">{tip}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="px-6 py-8 sm:px-8 sm:py-10 bg-white flex flex-col">
          {portfolio.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 mb-6">
              {portfolio.map((item) => (
                <div key={item.id} className="relative group">
                  <div className="relative overflow-hidden rounded-lg border border-gray-200 aspect-4/3">
                    <button
                      type="button"
                      onClick={() => openMobileActions(item)}
                      className="absolute inset-0 z-10 cursor-pointer md:hidden"
                      aria-label={item.title || t("profile.portfolioItemAlt")}
                    />
                    <AppImage src={item.image} alt={item.title} fill sizes="(max-width: 768px) 50vw, 33vw" className="object-cover" />
                    <div className="absolute top-2 right-2 hidden gap-2 opacity-0 transition-opacity md:flex group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => handleEditItem(item)}
                        title={t("common.edit")}
                        aria-label={t("common.edit")}
                        className="p-2 bg-white/95 text-gray-700 rounded-full hover:bg-white cursor-pointer shadow-sm"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(item.id)}
                        title={t("profile.deleteItem", "Supprimer")}
                        aria-label={t("profile.deleteItem", "Supprimer")}
                        className="p-2 bg-red-500 text-white rounded-full hover:bg-red-600 cursor-pointer shadow-sm"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-gray-700 mt-2 font-medium line-clamp-2">{item.title}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 mb-6">{t("profile.noPortfolio")}</p>
          )}

          <div className="mt-auto space-y-2">
            <input
              type="file"
              accept="image/*"
              id="portfolio-upload"
              onChange={handleUpload}
              title={addItemLabel}
              aria-label={addItemLabel}
              className="hidden"
            />
            <Button
              type="button"
              onClick={() => document.getElementById("portfolio-upload")?.click()}
              className="w-full bg-green-700 hover:bg-green-800 text-white font-semibold h-12 gap-2 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              {t("profile.chooseFiles")}
            </Button>
            <p className="text-xs text-gray-400 text-center">{t("profile.maxFileSize")}</p>
          </div>
        </div>
      </div>

      {showActionModal && selectedItem && (
        <div className="fixed inset-0 z-110 flex items-end bg-black/55 p-4 md:hidden">
          <div className="w-full rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mb-4 text-center">
              <p className="text-sm text-gray-500">{sectionTitle}</p>
              <h3 className="mt-1 text-base font-semibold text-gray-900">{selectedItem.title}</h3>
            </div>

            <div className="space-y-3">
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full justify-center gap-2 cursor-pointer"
                onClick={() => handleEditItem(selectedItem)}
              >
                <Pencil className="h-4 w-4" />
                {t("common.edit")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full justify-center gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 cursor-pointer"
                onClick={() => {
                  onRemove(selectedItem.id);
                  closeActionModal();
                }}
              >
                <Trash2 className="h-4 w-4" />
                {t("common.delete")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full cursor-pointer"
                onClick={closeActionModal}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showModal && image && (
        <ImageCropModal
          image={image}
          aspect={4 / 3}
          title={selectedItem ? t("common.edit") : addItemLabel}
          saveLabel={selectedItem ? t("common.save") : addButtonLabel}
          onCancel={closeModal}
          onSave={handleCropSave}
          footer={
            <div>
              <Input
                type="text"
                placeholder={titlePlaceholder}
                value={title}
                onChange={(e) => { setTitle(e.target.value); setError(false); }}
                className={error ? "border-red-500" : ""}
              />
              {error && <p className="text-xs text-red-500 mt-1">{t("profile.titleRequired")}</p>}
            </div>
          }
        />
      )}
    </>
  );
}
