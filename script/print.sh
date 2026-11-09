#!/bin/bash
#
# Copyright (C) 2018-2026 Modding Craft ZBD Studio.
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along
# with this program; if not, write to the Free Software Foundation, Inc.,
# 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
#

# Parameter order: Location TeamName teamid FilePath OriginalFileName
LOCATION="$1"
TEAMNAME="$2"
TEAMID="$3"
FILE="$4"
ORIGNAME="$5"

# ================= Configuration =================
PRINT_API="http://127.0.0.1/wxt/print"
API_TOKEN="3486dsay89x6786f87aerfbxncmbmghjf"
DENIED_LOCATION="Online"
# ==================================================

# Clean up input parameters (remove quotes and extra spaces)
LOCATION=$(echo "$LOCATION" | tr -d "'\"" | xargs)
TEAMNAME=$(echo "$TEAMNAME" | tr -d "'\"" | xargs)
TEAMID=$(echo "$TEAMID" | tr -d "'\"" | xargs)
FILE=$(echo "$FILE" | tr -d "'\"" | xargs)
ORIGNAME=$(echo "$ORIGNAME" | tr -d "'\"" | xargs)

# Print basic info
echo "====================="
echo "Team Location: [${LOCATION}]"
echo "Team Name: [${TEAMNAME}]"
echo "Team Id: [${TEAMID}]"
echo "Source File Path: [${FILE}]"
echo "Source File Name: [${ORIGNAME}]"
echo "====================="

# --------------------------
# Validation 1: Required fields
# --------------------------
if [ -z "$TEAMNAME" ] || [ -z "$LOCATION" ] || [ -z "$ORIGNAME" ] || [ -z "$TEAMID" ]; then
    echo "Error: Team location/name/id and original file name cannot be empty."
    exit 1
fi

# --------------------------
# Validation 2: Denied location (Online)
# --------------------------
if [[ "$LOCATION" == "$DENIED_LOCATION" ]]; then
    echo "Error: Printing is denied for location 'Online'."
    exit 1
fi

# --------------------------
# Validation 3: Allowed file types only
# --------------------------
if [[ ! ($ORIGNAME == *.c || $ORIGNAME == *.cpp || $ORIGNAME == *.py || $ORIGNAME == *.txt || $ORIGNAME == *.java) ]]; then
    echo "Error: Only .c, .cpp, .py, .txt, .java files are allowed."
    exit 1
fi

# --------------------------
# Check required system tools
# --------------------------
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required but not installed."; exit 1; }

# --------------------------
# Send print request to API
# --------------------------
echo "Submitting print task to server..."
curl -X POST "$PRINT_API" \
-H "org.domjudge.print-token: $API_TOKEN" \
-F "file=@${FILE};filename=${ORIGNAME}" \
-F "original=${ORIGNAME}" \
-F "location=${LOCATION}" \
-F "teamname=${TEAMNAME}" \
-F "teamid=${TEAMID}"