use crate::{
    constants::VK_TREE_HEIGHT, merkle_tree::membership::assert_check_membership,
    utils::arrays::find_index_hint,
};
use super::verification_key::VerificationKey;

pub struct VkData<let VK_LENGTH: u32> {
    vk: VerificationKey<VK_LENGTH>,
    vk_index: u32,
    vk_path: [Field; VK_TREE_HEIGHT],
}

impl<let VK_LENGTH: u32> VkData<VK_LENGTH> {
    pub fn validate_in_vk_tree<let N: u32>(self, vk_tree_root: Field, allowed_indices: [u32; N]) {
        self.vk.check_hash();

        let index_hint =
            unsafe { find_index_hint(allowed_indices, |index: u32| index == self.vk_index) };
        assert(index_hint < N, "Invalid vk index");
        assert_eq(allowed_indices[index_hint], self.vk_index, "Invalid vk index");

        assert_check_membership(
            self.vk.hash,
            self.vk_index as Field,
            self.vk_path,
            vk_tree_root,
        );
    }
}
