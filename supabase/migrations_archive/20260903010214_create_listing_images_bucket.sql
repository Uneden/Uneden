-- Bucket for listing photos, mirroring the chat-attachments setup.
-- Listing images were previously stored as base64 data URLs inside
-- services.image_urls, which bloated every row read by the listing grid.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-images',
  'listing-images',
  true,
  5242880,
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

-- Listings are public, so anyone may read.
create policy "Anyone can view listing images"
  on storage.objects for select
  to public
  using (bucket_id = 'listing-images');

-- Each user uploads into a folder named after their auth uid.
create policy "Users can upload listing images to their own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

create policy "Users can delete their own listing images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );
