export const queryKeys = {
  FOLDER_LIST: 'folder-list', // [FOLDER_LIST, groupId]
  FOLDER_DETAIL: 'folder-detail',
  POST_LIST: 'post-list', // [POST_LIST, folderId]
  METADATA: 'metadata', // [METADATA, url] 저장 전 기기 메타(SaveLinkSheet 전용) — 카드는 DB 컬럼(posts.preview_*)을 쓴다
  USER_PROFILE: 'userProfile',
  GROUP_LIST: 'group-list',
  GROUP_ACTIVITY: 'group-activity', // 그룹별 최근 활동(안읽음 배지용)
  GROUP_MEMBERS: 'group-members', // [GROUP_MEMBERS, groupId]
  GROUP_MEMBERS_PREVIEW: 'group-members-preview', // [GROUP_MEMBERS_PREVIEW, ids]
  GROUP_INVITE: 'group-invite', // [GROUP_INVITE, groupId]
  INVITE_PREVIEW: 'invite-preview', // [INVITE_PREVIEW, token]
} as const;
