
CREATE POLICY "Users can update their own membership"
ON chat_room_member
FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
