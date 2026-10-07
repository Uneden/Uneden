"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Camera } from "lucide-react";
import type { Area } from "react-easy-crop";
import ImageCropModal from "@/components/ui/ImageCropModal";
import getCroppedImg from "@/utils/cropImage";
import { uploadUserImage } from "@/lib/listingImages";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

interface ProfilePictureUploaderProps {
currentProfilePicture: string;
userName: string;
onProfileChange: (newProfilePicture: string) => void;
size?: "sm" | "md" | "lg" | "xl" | "2xl";
showLabel?: boolean;
readOnly?: boolean;
}

export default function ProfilePictureUploader({
    currentProfilePicture,
    userName,
    onProfileChange,
    size = "md",
    showLabel = true,
    readOnly = false,
    }: ProfilePictureUploaderProps) {
        const { t } = useTranslation();
        const [showCropper, setShowCropper] = useState(false);
        const [imageToCrop, setImageToCrop] = useState<string | null>(null);

        const sizeClasses = {
            sm: "w-16 h-16",
            md: "w-24 h-24",
            lg: "w-32 h-32",
            xl: "w-40 h-40",
            "2xl": "w-48 h-48",
        } as const;

        const handleProfileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;

            if (!file.type.startsWith("image/")) {
            toast.error(t("profile.invalidImageType"));
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
            onProfileChange(await uploadUserImage(croppedImage, "avatar"));
            setShowCropper(false);
            setImageToCrop(null);
            } catch {
            toast.error(t("profile.uploadError"));
            }
        };
        return (
        <>
        <div className="flex flex-col items-center gap-3">
            <Avatar className={`${sizeClasses[size]} border-4 border-gray-100`}>
            <AvatarImage src={currentProfilePicture} alt={userName} />
            <AvatarFallback className="text-2xl bg-green-100 text-green-800 font-semibold">{userName.charAt(0)}</AvatarFallback>
            </Avatar>
            {!readOnly && (
                <div className="flex flex-col items-center gap-2">
            <input
                type="file"
                accept="image/*"
                id="profileInput"
                onChange={handleProfileUpload}
                className="hidden"
            />

            <Button
                variant="outline"
                className="gap-2 cursor-pointer"
                onClick={() => document.getElementById("profileInput")?.click()}
                type="button"
            >
                <Camera className="h-4 w-4" />
                {t("profile.uploadImageLabel")}
            </Button>
            {showLabel && (
                <p className="text-xs text-gray-500">{t("profile.imageHint")}</p>
            )}
            </div>
            )}
        </div>

        {showCropper && imageToCrop && (
            <ImageCropModal
              image={imageToCrop}
              aspect={1}
              cropShape="round"
              title={t("profile.adjustPhoto")}
              saveLabel={t("profile.save")}
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
