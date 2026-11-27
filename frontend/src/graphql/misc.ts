import { gql } from '@apollo/client';
import { USER_FIELDS } from './operations';

export const SEARCH = gql`
  query Search($query: String!, $kinds: [SearchKind!], $limit: Int, $projectId: ID) {
    search(query: $query, kinds: $kinds, limit: $limit, projectId: $projectId) {
      query
      groups {
        kind
        total
        hits {
          kind
          id
          title
          detail
          projectId
          projectName
          outsideProjects
          worksessionBranch
          status
          activity
          updatedAt
        }
      }
    }
  }
`;

export const USERS = gql`
  ${USER_FIELDS}
  query Users {
    users {
      ...UserFields
      hasPassword
    }
  }
`;

export const INVITE_USER = gql`
  ${USER_FIELDS}
  mutation InviteUser($email: String!, $isAdmin: Boolean) {
    inviteUser(email: $email, isAdmin: $isAdmin) {
      ...UserFields
    }
  }
`;

export const SET_USER_ADMIN = gql`
  ${USER_FIELDS}
  mutation SetUserAdmin($userId: ID!, $isAdmin: Boolean!) {
    setUserAdmin(userId: $userId, isAdmin: $isAdmin) {
      ...UserFields
    }
  }
`;

export const SET_USER_SUPER_ADMIN = gql`
  ${USER_FIELDS}
  mutation SetUserSuperAdmin($userId: ID!, $isSuperAdmin: Boolean!) {
    setUserSuperAdmin(userId: $userId, isSuperAdmin: $isSuperAdmin) {
      ...UserFields
    }
  }
`;

export const SET_USER_CTO = gql`
  ${USER_FIELDS}
  mutation SetUserCto($userId: ID!, $isCto: Boolean!) {
    setUserCto(userId: $userId, isCto: $isCto) {
      ...UserFields
    }
  }
`;

export const DELETE_USER = gql`
  mutation DeleteUser($userId: ID!) {
    deleteUser(userId: $userId)
  }
`;

export const PUSH_PUBLIC_KEY = gql`
  query PushPublicKey {
    pushPublicKey
  }
`;

export const SUBSCRIBE_PUSH = gql`
  mutation SubscribePush($input: PushSubscriptionInput!) {
    subscribePush(input: $input)
  }
`;

export const UNSUBSCRIBE_PUSH = gql`
  mutation UnsubscribePush($endpoint: String!) {
    unsubscribePush(endpoint: $endpoint)
  }
`;

export const SEND_TEST_PUSH = gql`
  mutation SendTestPush {
    sendTestPush
  }
`;

export interface SharedPage {
  id: string;
  title: string;
  description: string | null;
  owner: { id: string; name: string; email: string };
  linkAccess: boolean;
  /** Visible par tout le monde avec le lien, sans connexion. */
  publicAccess: boolean;
  /** Visible par tout membre du projet d'origine (sauf les invités). */
  projectAccess: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  members: { user: { id: string; name: string; email: string; isGuest?: boolean }; addedBy: { id: string; name: string } | null; addedAt: string; message?: string | null }[];
  /** Chaque version garde son HTML, son type, son rafraîchissement et la définition de ses sources (sourceCount null : non gardée). */
  versions: { version: number; size: number; createdBy: { id: string; name: string } | null; createdAt: string; kind: ArtifactKind; refreshMinutes: number | null; sourceCount: number | null }[];
  project: { id: string; name: string } | null;
  session: { id: string; name: string } | null;
  sourcePath: string | null;
  viewerAccess: { owner: boolean; member: boolean; admin: boolean };
  /** Anciennes versions consultables ; false = `versions` ne contient que la dernière. */
  historyEnabled: boolean;
  /** Commentaires non traités. */
  openComments: number;
  /** Renvoi des commentaires à la session d'origine (OFF sans session). */
  agentHandoff: SharedPageAgentHandoff;
  /** Type d'artefact : page HTML, ou page alimentée par des sources de données rafraîchies par Skipper. */
  kind: ArtifactKind;
  /** Données : intervalle du rafraîchissement automatique en minutes ; null = à la demande. */
  refreshMinutes: number | null;
  dataRefreshedAt: string | null;
  sources: SharedPageSource[];
  /** Données : règles d'alerte sur les sources, avec leur état (dernière version). */
  alerts?: SharedPageAlert[];
  /** Mis en favori par la personne connectée : son lien reste dans la sidebar. */
  favorite: boolean;
}

export type ArtifactKind = 'PAGE' | 'DATA' | 'SLIDES';

export interface SharedPageSource {
  id: string;
  name: string;
  kind: 'sql' | 'script' | 'graphql' | 'agent';
  item: string | null;
  database: string | null;
  /** Propriétaire ou administrateur seulement. */
  query: string | null;
  /** graphql : variables (valeurs modèles comprises), propriétaire ou administrateur seulement. */
  variables?: Record<string, unknown> | null;
  interpreter: string | null;
  code: string | null;
  timeoutSeconds: number | null;
  /** agent : consigne de la session (propriétaire ou administrateur seulement), agent qui la calcule, dernière session lancée. */
  prompt?: string | null;
  agent?: string | null;
  sessionId?: string | null;
  /** inactive : source d'une ancienne version dont la définition a changé depuis (plus rafraîchie, sans données). */
  status: 'pending' | 'ok' | 'error' | 'skipped' | 'running' | 'inactive' | 'live';
  error: string | null;
  rowCount: number | null;
  durationMs: number | null;
  refreshedAt: string | null;
  attemptedAt: string | null;
}

/** Règle d'alerte d'un artefact de données : actions au franchissement seulement (déclenchée, puis revenue à la normale). */
export interface SharedPageAlert {
  id: string;
  name: string;
  source: string;
  path: string;
  op: string;
  value: unknown;
  match: 'any' | 'all';
  for: number;
  /** Condition lisible (« stats.rows.0.taux > 5 »). */
  condition: string;
  notify: 'owner' | 'project' | 'none';
  notifyResolved: boolean;
  agent: string | null;
  launchesSession: boolean;
  /** Propriétaire ou administrateur seulement. */
  prompt: string | null;
  message: string | null;
  state: 'unknown' | 'ok' | 'firing';
  streak: number;
  lastValue: unknown;
  evaluatedAt: string | null;
  triggeredAt: string | null;
  resolvedAt: string | null;
  fireCount: number;
  sessionId: string | null;
  error: string | null;
}

/** Renvoi des commentaires à l'agent : désactivé, sur demande (bouton), ou automatique (chaque commentaire). */
export type SharedPageAgentHandoff = 'OFF' | 'MANUAL' | 'AUTO';

/** Élément de la page visé par un commentaire (choisi en cliquant dans la page). */
export interface SharedPageAnchor {
  selector: string;
  text: string | null;
  tag: string | null;
}

/** Commentaire d'une page partagée : racine (micro-conversation avec `replies`, état traité) ou réponse. */
export interface SharedPageComment {
  id: string;
  author: { id: string; name: string };
  viaAgent: boolean;
  body: string;
  anchor: SharedPageAnchor | null;
  version: number;
  resolved: boolean;
  resolvedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  replies: SharedPageComment[];
}

export const SHARED_PAGE_FIELDS = gql`
  fragment SharedPageFields on SharedPage {
    id
    title
    description
    owner {
      id
      name
      email
    }
    linkAccess
    publicAccess
    projectAccess
    agentHandoff
    historyEnabled
    favorite
    kind
    refreshMinutes
    dataRefreshedAt
    sources {
      id
      name
      kind
      item
      database
      query
      variables
      interpreter
      code
      timeoutSeconds
      prompt
      agent
      sessionId
      status
      error
      rowCount
      durationMs
      refreshedAt
      attemptedAt
    }
    alerts {
      id
      name
      source
      path
      op
      value
      match
      for
      condition
      notify
      notifyResolved
      agent
      launchesSession
      prompt
      message
      state
      streak
      lastValue
      evaluatedAt
      triggeredAt
      resolvedAt
      fireCount
      sessionId
      error
    }
    version
    createdAt
    updatedAt
    members {
      user {
        id
        name
        email
        isGuest
      }
      addedBy {
        id
        name
      }
      addedAt
      message
    }
    versions {
      version
      size
      createdBy {
        id
        name
      }
      createdAt
      kind
      refreshMinutes
      sourceCount
    }
    project {
      id
      name
    }
    session {
      id
      name
    }
    sourcePath
    viewerAccess {
      owner
      member
      admin
    }
    openComments
  }
`;

export const SHARED_PAGE_COMMENT_FIELDS = gql`
  fragment SharedPageCommentFields on SharedPageComment {
    id
    author {
      id
      name
    }
    viaAgent
    body
    anchor {
      selector
      text
      tag
    }
    version
    resolved
    resolvedBy {
      id
      name
    }
    resolvedAt
    createdAt
    updatedAt
  }
`;

/** Commentaires d'une page, avec leurs réponses (sondés à part de la page, plus souvent). */
export const SHARED_PAGE_COMMENTS = gql`
  ${SHARED_PAGE_COMMENT_FIELDS}
  query SharedPageComments($id: ID!) {
    sharedPage(id: $id) {
      id
      version
      openComments
      comments {
        ...SharedPageCommentFields
        replies {
          ...SharedPageCommentFields
        }
      }
    }
  }
`;

export const ADD_SHARED_PAGE_COMMENT = gql`
  mutation AddSharedPageComment($pageId: ID!, $body: String!, $anchor: SharedPageAnchorInput, $version: Int) {
    addSharedPageComment(pageId: $pageId, body: $body, anchor: $anchor, version: $version) {
      id
    }
  }
`;

export const REPLY_SHARED_PAGE_COMMENT = gql`
  mutation ReplySharedPageComment($commentId: ID!, $body: String!) {
    replySharedPageComment(commentId: $commentId, body: $body) {
      id
    }
  }
`;

export const UPDATE_SHARED_PAGE_COMMENT = gql`
  mutation UpdateSharedPageComment($id: ID!, $body: String!) {
    updateSharedPageComment(id: $id, body: $body) {
      id
      body
      updatedAt
    }
  }
`;

export const RESOLVE_SHARED_PAGE_COMMENT = gql`
  mutation ResolveSharedPageComment($id: ID!, $resolved: Boolean!) {
    resolveSharedPageComment(id: $id, resolved: $resolved) {
      id
      resolved
      resolvedAt
      resolvedBy {
        id
        name
      }
    }
  }
`;

export const REQUEST_SHARED_PAGE_UPDATE = gql`
  mutation RequestSharedPageUpdate($id: ID!, $instruction: String, $withComments: Boolean) {
    requestSharedPageUpdate(id: $id, instruction: $instruction, withComments: $withComments) {
      id
      name
    }
  }
`;

export const DELETE_SHARED_PAGE_COMMENT = gql`
  mutation DeleteSharedPageComment($id: ID!) {
    deleteSharedPageComment(id: $id)
  }
`;

export const SHARED_PAGES = gql`
  ${SHARED_PAGE_FIELDS}
  query SharedPages($projectId: ID) {
    sharedPages(projectId: $projectId) {
      ...SharedPageFields
    }
  }
`;

/** Pages publiées depuis une session (section « Pages » de l'onglet Session du panneau de droite). */
export type SessionPage = Pick<SharedPage, 'id' | 'title' | 'linkAccess' | 'version' | 'updatedAt' | 'openComments'> & { owner: { id: string; name: string }; members: { user: { id: string } }[] };
export const SESSION_PAGES = gql`
  query SessionPages($id: ID!) {
    session(id: $id) {
      id
      pages {
        id
        title
        linkAccess
        version
        updatedAt
        openComments
        owner {
          id
          name
        }
        members {
          user {
            id
          }
        }
      }
    }
  }
`;

export const SHARED_PAGE = gql`
  ${SHARED_PAGE_FIELDS}
  query SharedPage($id: ID!) {
    sharedPage(id: $id) {
      ...SharedPageFields
    }
  }
`;

export const PUBLISH_SHARED_PAGE = gql`
  ${SHARED_PAGE_FIELDS}
  mutation PublishSharedPage($projectId: ID!, $worksessionId: ID, $path: String!, $title: String!, $pageId: ID) {
    publishSharedPage(projectId: $projectId, worksessionId: $worksessionId, path: $path, title: $title, pageId: $pageId) {
      ...SharedPageFields
    }
  }
`;

export const REFRESH_SHARED_PAGE_DATA = gql`
  ${SHARED_PAGE_FIELDS}
  mutation RefreshSharedPageData($id: ID!) {
    refreshSharedPageData(id: $id) {
      ...SharedPageFields
    }
  }
`;

/** Sources d'un artefact de données telles qu'à une ancienne version (panneau « Données » de cette version). */
export const SHARED_PAGE_VERSION_SOURCES = gql`
  query SharedPageVersionSources($id: ID!, $version: Int!) {
    sharedPage(id: $id) {
      id
      versionSources: sources(version: $version) {
        id
        name
        kind
        item
        database
        query
        interpreter
        code
        timeoutSeconds
        prompt
        agent
        sessionId
        status
        error
        rowCount
        durationMs
        refreshedAt
        attemptedAt
      }
    }
  }
`;

/** Artefacts en favori de la personne : section « Favoris » de la sidebar. */
export type FavoriteSharedPage = Pick<SharedPage, 'id' | 'title' | 'kind' | 'openComments'> & { project?: { id: string } | null };
export const FAVORITE_SHARED_PAGES = gql`
  query FavoriteSharedPages {
    favoriteSharedPages {
      id
      title
      kind
      openComments
      favorite
      project {
        id
      }
    }
  }
`;

export const SET_SHARED_PAGE_FAVORITE = gql`
  mutation SetSharedPageFavorite($id: ID!, $favorite: Boolean!) {
    setSharedPageFavorite(id: $id, favorite: $favorite) {
      id
      favorite
    }
  }
`;

export const DUPLICATE_SHARED_PAGE = gql`
  mutation DuplicateSharedPage($id: ID!, $title: String, $version: Int) {
    duplicateSharedPage(id: $id, title: $title, version: $version) {
      id
      title
    }
  }
`;

export const UPDATE_SHARED_PAGE = gql`
  ${SHARED_PAGE_FIELDS}
  mutation UpdateSharedPage($id: ID!, $input: SharedPageInput!) {
    updateSharedPage(id: $id, input: $input) {
      ...SharedPageFields
    }
  }
`;

export const ADD_SHARED_PAGE_MEMBER = gql`
  ${SHARED_PAGE_FIELDS}
  mutation AddSharedPageMember($id: ID!, $email: String!, $invite: Boolean, $message: String, $notify: Boolean) {
    addSharedPageMember(id: $id, email: $email, invite: $invite, message: $message, notify: $notify) {
      ...SharedPageFields
    }
  }
`;

export const REMOVE_SHARED_PAGE_MEMBER = gql`
  ${SHARED_PAGE_FIELDS}
  mutation RemoveSharedPageMember($id: ID!, $userId: ID!) {
    removeSharedPageMember(id: $id, userId: $userId) {
      ...SharedPageFields
    }
  }
`;

export const SET_SHARED_PAGE_HISTORY = gql`
  ${SHARED_PAGE_FIELDS}
  mutation SetSharedPageHistory($id: ID!, $enabled: Boolean!) {
    setSharedPageHistory(id: $id, enabled: $enabled) {
      ...SharedPageFields
    }
  }
`;

export const DELETE_ALL_SHARED_PAGE_COMMENTS = gql`
  mutation DeleteAllSharedPageComments($id: ID!) {
    deleteAllSharedPageComments(id: $id)
  }
`;

export const DELETE_SHARED_PAGE = gql`
  mutation DeleteSharedPage($id: ID!) {
    deleteSharedPage(id: $id)
  }
`;

/** Famille de notifications qu'une personne reçoit ou non en push (et en notification du navigateur). */
export interface PushCategory {
  key: string;
  label: string;
  description: string;
  types: string[];
  enabled: boolean;
  adminsOnly: boolean;
}

export const PUSH_PREFERENCES = gql`
  query PushPreferences {
    pushPreferences {
      key
      label
      description
      types
      enabled
      adminsOnly
    }
  }
`;

export const SET_PUSH_PREFERENCE = gql`
  mutation SetPushPreference($category: String!, $enabled: Boolean!) {
    setPushPreference(category: $category, enabled: $enabled) {
      key
      label
      description
      types
      enabled
      adminsOnly
    }
  }
`;

export interface NotificationChannel {
  id: string;
  projectId: string | null;
  userId: string | null;
  kind: 'slack' | 'discord' | 'email';
  targetHint: string;
  categories: string[];
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const CHANNEL_FIELDS = gql`
  fragment NotificationChannelFields on NotificationChannel {
    id
    projectId
    userId
    kind
    targetHint
    categories
    enabled
    lastSentAt
    lastError
    createdAt
  }
`;

/** Un e-mail peut-il partir (envoi des e-mails configuré) ? Sert à dire si l'invitation à une page a été envoyée. */
export const EMAIL_AVAILABLE = gql`
  query EmailAvailable {
    emailNotificationsAvailable
  }
`;

export const MY_NOTIFICATION_CHANNELS = gql`
  query MyNotificationChannels {
    myNotificationChannels {
      ...NotificationChannelFields
    }
    emailNotificationsAvailable
  }
  ${CHANNEL_FIELDS}
`;

export const PROJECT_NOTIFICATION_CHANNELS = gql`
  query ProjectNotificationChannels($projectId: ID!) {
    projectNotificationChannels(projectId: $projectId) {
      ...NotificationChannelFields
    }
    emailNotificationsAvailable
  }
  ${CHANNEL_FIELDS}
`;

export const CREATE_NOTIFICATION_CHANNEL = gql`
  mutation CreateNotificationChannel($input: NotificationChannelInput!) {
    createNotificationChannel(input: $input) {
      ...NotificationChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

export const UPDATE_NOTIFICATION_CHANNEL = gql`
  mutation UpdateNotificationChannel($id: ID!, $patch: NotificationChannelPatch!) {
    updateNotificationChannel(id: $id, patch: $patch) {
      ...NotificationChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

export const DELETE_NOTIFICATION_CHANNEL = gql`
  mutation DeleteNotificationChannel($id: ID!) {
    deleteNotificationChannel(id: $id)
  }
`;

export const TEST_NOTIFICATION_CHANNEL = gql`
  mutation TestNotificationChannel($id: ID!) {
    testNotificationChannel(id: $id) {
      ...NotificationChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

export interface MailSettings {
  source: 'env' | 'settings' | 'none';
  provider: string;
  from: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
}

const MAIL_FIELDS = gql`
  fragment MailSettingsFields on MailSettings {
    source
    provider
    from
    hasApiKey
    apiKeyHint
  }
`;

export const MAIL_SETTINGS = gql`
  query MailSettings {
    mailSettings {
      ...MailSettingsFields
    }
  }
  ${MAIL_FIELDS}
`;

export const UPDATE_MAIL_SETTINGS = gql`
  mutation UpdateMailSettings($input: MailSettingsInput!) {
    updateMailSettings(input: $input) {
      ...MailSettingsFields
    }
  }
  ${MAIL_FIELDS}
`;

export const CLEAR_MAIL_SETTINGS = gql`
  mutation ClearMailSettings {
    clearMailSettings {
      ...MailSettingsFields
    }
  }
  ${MAIL_FIELDS}
`;

export const SEND_TEST_EMAIL = gql`
  mutation SendTestEmail {
    sendTestEmail
  }
`;

/** Rôle de la personne sur un projet, pour aiguiller un invité vers ses conversations (components/GuestGate.tsx). */
export const PROJECT_ROLE = gql`
  query ProjectRole($id: ID!) {
    project(id: $id) {
      id
      myRole
    }
  }
`;

/** Projets où la personne n'est qu'invitée (conversations et artefacts partagés seulement). */
export const GUEST_PROJECTS = gql`
  query GuestProjects {
    guestProjects {
      id
      name
      unreadMessages
    }
  }
`;

/** Débuts d'identifiants cités seuls dans un texte, résolus en tâches ou sessions (voir lib/useKnownRefs). */
export const RESOLVE_REFS = gql`
  query ResolveRefs($prefixes: [String!]!) {
    resolveRefs(prefixes: $prefixes) {
      prefix
      kind
      id
    }
  }
`;
