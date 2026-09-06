def rotate_api_key(api_key):
    return rotate_secret("/keys/" + api_key)
