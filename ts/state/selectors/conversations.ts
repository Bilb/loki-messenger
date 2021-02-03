import { createSelector } from 'reselect';

import { LocalizerType } from '../../types/Util';
import { StateType } from '../reducer';
import {
  ConversationLookupType,
  ConversationsStateType,
  ConversationType,
} from '../ducks/conversations';

import { getIntl, getOurNumber } from './user';
import { BlockedNumberController } from '../../util';
import { MessageModel } from '../../models/message';

export const getConversations = (state: StateType): ConversationsStateType =>
  state.conversations;

export const getConversationLookup = createSelector(
  getConversations,
  (state: ConversationsStateType): ConversationLookupType => {
    return state.conversationLookup;
  }
);

export const getSelectedConversationKey = createSelector(
  getConversations,
  (state: ConversationsStateType): string | undefined => {
    return state.selectedConversation;
  }
);

export const getSelectedConversation = createSelector(
  getConversations,
  (state: ConversationsStateType): ConversationType | undefined => {
    return state.selectedConversation
      ? state.conversationLookup[state.selectedConversation]
      : undefined;
  }
);

export const getOurPrimaryConversation = createSelector(
  getConversations,
  (state: ConversationsStateType): ConversationType =>
    state.conversationLookup[window.storage.get('primaryDevicePubKey')]
);

export const getMessagesOfSelectedConversation = createSelector(
  getConversations,
  (state: ConversationsStateType): Array<MessageModel> => state.messages
);

function getConversationTitle(conversation: ConversationType): string {
  if (conversation.name) {
    return conversation.name;
  }

  if (conversation.type === 'group') {
    const { i18n } = window;
    return i18n('unknown');
  }
  return conversation.id;
}

const collator = new Intl.Collator();

export const _getConversationComparator = (i18n: LocalizerType) => {
  return (left: ConversationType, right: ConversationType): number => {
    const leftTimestamp = left.timestamp;
    const rightTimestamp = right.timestamp;
    if (leftTimestamp && !rightTimestamp) {
      return -1;
    }
    if (rightTimestamp && !leftTimestamp) {
      return 1;
    }
    if (leftTimestamp && rightTimestamp && leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }
    const leftTitle = getConversationTitle(left).toLowerCase();
    const rightTitle = getConversationTitle(right).toLowerCase();

    return collator.compare(leftTitle, rightTitle);
  };
};
export const getConversationComparator = createSelector(
  getIntl,
  _getConversationComparator
);

export const _getLeftPaneLists = (
  lookup: ConversationLookupType,
  comparator: (left: ConversationType, right: ConversationType) => number,
  selectedConversation?: string
): {
  conversations: Array<ConversationType>;
  contacts: Array<ConversationType>;
  unreadCount: number;
} => {
  const values = Object.values(lookup);
  const sorted = values.sort(comparator);

  const conversations: Array<ConversationType> = [];
  const allContacts: Array<ConversationType> = [];

  let index = 0;

  let unreadCount = 0;
  for (let conversation of sorted) {
    if (selectedConversation === conversation.id) {
      conversation = {
        ...conversation,
        isSelected: true,
      };
    }
    const isBlocked =
      BlockedNumberController.isBlocked(conversation.id) ||
      BlockedNumberController.isGroupBlocked(conversation.id);

    if (isBlocked) {
      conversation = {
        ...conversation,
        isBlocked: true,
      };
    }

    conversation.index = index;

    // Add Open Group to list as soon as the name has been set
    if (
      conversation.isPublic &&
      (!conversation.name || conversation.name === 'Unknown group')
    ) {
      continue;
    }

    // Show loading icon while fetching messages
    if (conversation.isPublic && !conversation.timestamp) {
      conversation.lastMessage = {
        status: 'sending',
        text: '',
      };
    }

    // Remove all invalid conversations and conversatons of devices associated
    //  with cancelled attempted links
    if (!conversation.isPublic && !conversation.activeAt) {
      continue;
    }

    if (conversation.activeAt !== undefined) {
      allContacts.push(conversation);
    }

    if (unreadCount < 9 && conversation.unreadCount > 0) {
      unreadCount += conversation.unreadCount;
    }

    conversations.push(conversation);
    index++;
  }

  return {
    conversations,
    contacts: allContacts,
    unreadCount,
  };
};

export const _getSessionConversationInfo = (
  lookup: ConversationLookupType,
  comparator: (left: ConversationType, right: ConversationType) => number,
  selectedConversation?: string
): {
  conversation: ConversationType | undefined;
  selectedConversation?: string;
} => {
  const values = Object.values(lookup);
  const sorted = values.sort(comparator);

  let conversation;
  const max = sorted.length;

  for (let i = 0; i < max; i += 1) {
    const conv = sorted[i];

    if (conv.id === selectedConversation) {
      conversation = conv;
      break;
    }
  }

  return {
    conversation,
    selectedConversation,
  };
};

export const getLeftPaneLists = createSelector(
  getConversationLookup,
  getConversationComparator,
  getSelectedConversationKey,
  _getLeftPaneLists
);

export const getSessionConversationInfo = createSelector(
  getConversationLookup,
  getConversationComparator,
  getSelectedConversationKey,
  _getSessionConversationInfo
);

export const getMe = createSelector(
  [getConversationLookup, getOurNumber],
  (lookup: ConversationLookupType, ourNumber: string): ConversationType => {
    return lookup[ourNumber];
  }
);
